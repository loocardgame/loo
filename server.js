const express = require("express");
const http = require("http");
const cors = require("cors");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { Server } = require("socket.io");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const JWT_SECRET = process.env.JWT_SECRET || "dev-insecure-change-me";
const SYSTEM_WALLET_ID = "00000000-0000-0000-0000-000000000002";

/* ============================================================
   AUXILIARES
   ============================================================ */

function publicUser(row) {
  if (!row) return null;

  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    avatarType: row.avatar_type,
    avatarEmoji: row.avatar_emoji,
    role: row.role,
    isGuest: row.is_guest,
    isActive: row.is_active,
    isBanned: row.is_banned,
    createdAt: row.created_at
  };
}

function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      role: user.role
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({
      ok: false,
      message: "Token não informado."
    });
  }

  try {
    req.auth = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (error) {
    return res.status(401).json({
      ok: false,
      message: "Token inválido ou expirado."
    });
  }
}

function adminRequired(req, res, next) {
  if (!req.auth || !["SYSTEM_ADMIN", "TABLE_ADMIN"].includes(req.auth.role)) {
    return res.status(403).json({
      ok: false,
      message: "Acesso restrito a administradores."
    });
  }

  return next();
}

/* ============================================================
   BASE
   ============================================================ */

app.get("/api", (req, res) => {
  res.json({
    ok: true,
    app: "Loo Card Game",
    status: "online"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "loo-api",
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    jwtConfigured: Boolean(process.env.JWT_SECRET)
  });
});

app.get("/db-test", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT now() AS server_time, COUNT(*)::int AS total_users
      FROM public.app_users;
    `);

    res.json({
      ok: true,
      message: "Conexão com Supabase/PostgreSQL funcionando",
      data: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: "Erro ao conectar no banco",
      error: error.message
    });
  }
});

/* ============================================================
   LOGIN
   ============================================================ */

app.post("/api/auth/login", async (req, res) => {
  const { login, password } = req.body;

  if (!login || !password) {
    return res.status(400).json({
      ok: false,
      message: "Informe usuário e senha."
    });
  }

  try {
    const result = await pool.query(
      `
      SELECT
        id,
        username,
        display_name,
        email,
        password_hash,
        avatar_type,
        avatar_emoji,
        role,
        is_guest,
        is_active,
        is_banned,
        created_at
      FROM public.app_users
      WHERE username = $1::citext
         OR email = $1::citext
      LIMIT 1;
      `,
      [login.trim()]
    );

    const user = result.rows[0];

    if (!user || !user.password_hash) {
      return res.status(401).json({
        ok: false,
        message: "Usuário ou senha inválidos."
      });
    }

    if (!user.is_active || user.is_banned) {
      return res.status(403).json({
        ok: false,
        message: "Usuário bloqueado ou inativo."
      });
    }

    const passwordOk = await bcrypt.compare(password, user.password_hash);

    if (!passwordOk) {
      return res.status(401).json({
        ok: false,
        message: "Usuário ou senha inválidos."
      });
    }

    await pool.query(
      `
      UPDATE public.app_users
      SET last_login_at = now(), last_seen_at = now()
      WHERE id = $1;
      `,
      [user.id]
    );

    const token = signToken(user);

    res.json({
      ok: true,
      message: "Login realizado com sucesso.",
      token,
      user: publicUser(user)
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: "Erro ao fazer login.",
      error: error.message
    });
  }
});

app.get("/api/me", authRequired, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        username,
        display_name,
        email,
        avatar_type,
        avatar_emoji,
        role,
        is_guest,
        is_active,
        is_banned,
        created_at
      FROM public.app_users
      WHERE id = $1
      LIMIT 1;
      `,
      [req.auth.sub]
    );

    if (!result.rows[0]) {
      return res.status(404).json({
        ok: false,
        message: "Usuário não encontrado."
      });
    }

    res.json({
      ok: true,
      user: publicUser(result.rows[0])
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: "Erro ao carregar usuário.",
      error: error.message
    });
  }
});

/* ============================================================
   ADMIN — USUÁRIOS
   ============================================================ */

app.get("/api/admin/users", authRequired, adminRequired, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id,
        u.username,
        u.display_name,
        u.role,
        u.is_active,
        u.is_banned,
        u.created_at,
        COALESCE(w.balance, 0)::numeric(18,2) AS global_balance,
        w.id AS global_wallet_id,
        (
          SELECT COUNT(*)::int
          FROM public.table_members tm
          WHERE tm.user_id = u.id
            AND tm.status = 'BLOCKED'
        ) AS blocked_tables_count
      FROM public.app_users u
      LEFT JOIN public.wallets w
        ON w.user_id = u.id
       AND w.wallet_type = 'USER_GLOBAL'
       AND w.currency_code = 'TEST_CHIP'
      WHERE u.login_provider <> 'SYSTEM'
      ORDER BY u.created_at DESC;
    `);

    res.json({
      ok: true,
      total: result.rows.length,
      users: result.rows
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: "Erro ao listar usuários.",
      error: error.message
    });
  }
});

app.post("/api/admin/users", authRequired, adminRequired, async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      ok: false,
      message: "Informe nick e senha."
    });
  }

  if (String(username).trim().length < 3) {
    return res.status(400).json({
      ok: false,
      message: "O nick precisa ter pelo menos 3 caracteres."
    });
  }

  if (String(password).length < 6) {
    return res.status(400).json({
      ok: false,
      message: "A senha precisa ter pelo menos 6 caracteres."
    });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const nick = username.trim();

    const result = await pool.query(
      `
      INSERT INTO public.app_users (
        username,
        display_name,
        password_hash,
        login_provider,
        avatar_type,
        avatar_emoji,
        role,
        is_guest,
        is_active,
        is_banned
      )
      VALUES ($1, $1, $2, 'EMAIL', 'EMOJI', '🃏', 'PLAYER', false, true, false)
      RETURNING
        id,
        username,
        display_name,
        role,
        is_active,
        is_banned,
        created_at;
      `,
      [nick, passwordHash]
    );

    res.json({
      ok: true,
      message: "Usuário criado com sucesso.",
      user: result.rows[0]
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        ok: false,
        message: "Esse nick já existe."
      });
    }

    res.status(500).json({
      ok: false,
      message: "Erro ao criar usuário.",
      error: error.message
    });
  }
});

app.post("/api/admin/users/:userId/toggle-ban", authRequired, adminRequired, async (req, res) => {
  const { userId } = req.params;
  const { blocked } = req.body;

  try {
    const result = await pool.query(
      `
      UPDATE public.app_users
      SET is_banned = $2
      WHERE id = $1
        AND login_provider <> 'SYSTEM'
      RETURNING id, username, display_name, role, is_banned;
      `,
      [userId, Boolean(blocked)]
    );

    res.json({
      ok: true,
      message: Boolean(blocked) ? "Usuário bloqueado." : "Usuário desbloqueado.",
      user: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: "Erro ao atualizar bloqueio.",
      error: error.message
    });
  }
});

/* ============================================================
   ADMIN — FICHAS
   ============================================================ */

app.post("/api/admin/chips/add-global", authRequired, adminRequired, async (req, res) => {
  const { userId, amount } = req.body;

  if (!userId || !amount || Number(amount) <= 0) {
    return res.status(400).json({
      ok: false,
      message: "Informe usuário e quantidade válida."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const walletResult = await client.query(
      `
      SELECT id
      FROM public.wallets
      WHERE user_id = $1
        AND wallet_type = 'USER_GLOBAL'
        AND currency_code = 'TEST_CHIP'
      LIMIT 1;
      `,
      [userId]
    );

    if (!walletResult.rows[0]) {
      throw new Error("Carteira global do usuário não encontrada.");
    }

    const tx = await client.query(
      `
      INSERT INTO public.chip_transactions (
        transaction_type,
        from_wallet_id,
        to_wallet_id,
        amount,
        status,
        requested_by_user_id,
        approved_by_user_id,
        created_by_user_id,
        description
      )
      VALUES (
        'ADMIN_ADD',
        $1,
        $2,
        $3,
        'COMPLETED',
        $4,
        $4,
        $4,
        'Crédito administrativo na carteira global.'
      )
      RETURNING *;
      `,
      [
        SYSTEM_WALLET_ID,
        walletResult.rows[0].id,
        Number(amount),
        req.auth.sub
      ]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      message: "Fichas adicionadas com sucesso.",
      transaction: tx.rows[0]
    });
  } catch (error) {
    await client.query("ROLLBACK");

    res.status(500).json({
      ok: false,
      message: "Erro ao adicionar fichas.",
      error: error.message
    });
  } finally {
    client.release();
  }
});

/* ============================================================
   ADMIN — MESAS
   ============================================================ */

app.post("/api/admin/tables", authRequired, adminRequired, async (req, res) => {
  const { name } = req.body;

  if (!name) {
    return res.status(400).json({
      ok: false,
      message: "Informe o nome da mesa."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const table = await client.query(
      `
      INSERT INTO public.game_tables (
        owner_user_id,
        name,
        max_players,
        initial_chips,
        visibility,
        status
      )
      VALUES ($1, $2, 6, 50, 'LINK_ONLY', 'WAITING')
      RETURNING *;
      `,
      [req.auth.sub, name.trim()]
    );

    await client.query(
      `
      INSERT INTO public.table_members (
        table_id,
        user_id,
        seat_number,
        role,
        status,
        is_online,
        is_ready
      )
      VALUES ($1, $2, 1, 'OWNER', 'WAITING', true, true);
      `,
      [table.rows[0].id, req.auth.sub]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      message: "Mesa criada.",
      table: table.rows[0]
    });
  } catch (error) {
    await client.query("ROLLBACK");

    res.status(500).json({
      ok: false,
      message: "Erro ao criar mesa.",
      error: error.message
    });
  } finally {
    client.release();
  }
});

/* ============================================================
   HALL DO JOGADOR
   ============================================================ */

app.get("/api/hall", authRequired, async (req, res) => {
  try {
    const userResult = await pool.query(
      `
      SELECT
        u.id,
        u.username,
        u.display_name,
        u.role,
        COALESCE(w.balance, 0)::numeric(18,2) AS global_balance,
        w.id AS global_wallet_id
      FROM public.app_users u
      LEFT JOIN public.wallets w
        ON w.user_id = u.id
       AND w.wallet_type = 'USER_GLOBAL'
       AND w.currency_code = 'TEST_CHIP'
      WHERE u.id = $1
      LIMIT 1;
      `,
      [req.auth.sub]
    );

    const tablesResult = await pool.query(`
      SELECT
        gt.id,
        gt.name,
        gt.invite_code,
        gt.status,
        gt.max_players,
        gt.created_at,
        au.display_name AS owner_name,
        COUNT(tm.id)::int AS members_count
      FROM public.game_tables gt
      JOIN public.app_users au
        ON au.id = gt.owner_user_id
      LEFT JOIN public.table_members tm
        ON tm.table_id = gt.id
       AND tm.status <> 'LEFT'
      WHERE gt.status IN ('WAITING', 'ACTIVE')
      GROUP BY gt.id, au.display_name
      ORDER BY gt.created_at DESC;
    `);

    res.json({
      ok: true,
      user: userResult.rows[0],
      tables: tablesResult.rows
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: "Erro ao carregar hall.",
      error: error.message
    });
  }
});

app.post("/api/tables/:tableId/join", authRequired, async (req, res) => {
  const { tableId } = req.params;
  const userId = req.auth.sub;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const userStatus = await client.query(
      `
      SELECT is_banned
      FROM public.app_users
      WHERE id = $1
      LIMIT 1;
      `,
      [userId]
    );

    if (userStatus.rows[0]?.is_banned) {
      throw new Error("Usuário bloqueado.");
    }

    const existing = await client.query(
      `
      SELECT *
      FROM public.table_members
      WHERE table_id = $1
        AND user_id = $2
      LIMIT 1;
      `,
      [tableId, userId]
    );

    if (existing.rows[0]) {
      await client.query("COMMIT");

      return res.json({
        ok: true,
        message: "Usuário já está nessa mesa.",
        member: existing.rows[0]
      });
    }

    const seatResult = await client.query(
      `
      SELECT COALESCE(MAX(seat_number), 0) + 1 AS next_seat
      FROM public.table_members
      WHERE table_id = $1
        AND seat_number IS NOT NULL;
      `,
      [tableId]
    );

    const member = await client.query(
      `
      INSERT INTO public.table_members (
        table_id,
        user_id,
        seat_number,
        role,
        status,
        is_online,
        is_ready
      )
      VALUES ($1, $2, $3, 'PLAYER', 'WAITING', true, false)
      RETURNING *;
      `,
      [tableId, userId, seatResult.rows[0].next_seat]
    );

    await client.query(
      `
      INSERT INTO public.hand_events (
        table_id,
        actor_user_id,
        event_type,
        action_type,
        public_message,
        is_public_log
      )
      VALUES (
        $1,
        $2,
        'PLAYER_JOINED',
        'ENTRAR_MESA',
        'Jogador entrou na mesa.',
        true
      );
      `,
      [tableId, userId]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      message: "Entrada na mesa realizada.",
      member: member.rows[0]
    });
  } catch (error) {
    await client.query("ROLLBACK");

    res.status(500).json({
      ok: false,
      message: "Erro ao entrar na mesa.",
      error: error.message
    });
  } finally {
    client.release();
  }
});

/* ============================================================
   SOCKET
   ============================================================ */

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

io.on("connection", (socket) => {
  console.log("Jogador conectado:", socket.id);

  socket.on("disconnect", () => {
    console.log("Jogador desconectado:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Servidor Loo Card Game rodando na porta ${PORT}`);
});
