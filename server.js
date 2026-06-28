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

/*
  Serve o frontend simples que ficará em:
  public/index.html
*/
app.use(express.static(path.join(__dirname, "public")));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const JWT_SECRET = process.env.JWT_SECRET || "dev-insecure-change-me";
const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000001";
const SYSTEM_WALLET_ID = "00000000-0000-0000-0000-000000000002";

/* ============================================================
   FUNÇÕES AUXILIARES
   ============================================================ */

function publicUser(row) {
  if (!row) return null;

  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    avatarType: row.avatar_type,
    avatarUrl: row.avatar_url,
    avatarKey: row.avatar_key,
    avatarColor: row.avatar_color,
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
    {
      expiresIn: "7d"
    }
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

async function getTableWallet(client, tableId, userId) {
  const result = await client.query(
    `
    SELECT *
    FROM public.wallets
    WHERE wallet_type = 'USER_TABLE'
      AND table_id = $1
      AND user_id = $2
      AND currency_code = 'TEST_CHIP'
    LIMIT 1;
    `,
    [tableId, userId]
  );

  return result.rows[0] || null;
}

async function getMemberWithWallet(client, memberId) {
  const result = await client.query(
    `
    SELECT
      tm.*,
      w.id AS wallet_id,
      w.balance AS wallet_balance,
      w.currency_code AS wallet_currency_code
    FROM public.table_members tm
    LEFT JOIN public.wallets w
      ON w.id = tm.table_wallet_id
    WHERE tm.id = $1
    LIMIT 1;
    `,
    [memberId]
  );

  return result.rows[0] || null;
}

/* ============================================================
   ROTAS BÁSICAS
   ============================================================ */

app.get("/api", (req, res) => {
  res.json({
    status: "online",
    app: "Lu Online / Loo Card Game",
    message: "Backend funcionando no Render",
    databaseConfigured: Boolean(process.env.DATABASE_URL)
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
      SELECT
        now() AS server_time,
        COUNT(*)::int AS total_users
      FROM public.app_users;
    `);

    res.json({
      ok: true,
      message: "Conexão com Supabase/PostgreSQL funcionando",
      data: result.rows[0]
    });
  } catch (error) {
    console.error("Erro no teste do banco:", error);

    res.status(500).json({
      ok: false,
      message: "Erro ao conectar no banco",
      error: error.message
    });
  }
});

app.get("/tables-test", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);

    res.json({
      ok: true,
      message: "Tabelas encontradas no banco",
      total: result.rows.length,
      tables: result.rows
    });
  } catch (error) {
    console.error("Erro ao listar tabelas:", error);

    res.status(500).json({
      ok: false,
      message: "Erro ao listar tabelas",
      error: error.message
    });
  }
});

/* ============================================================
   AUTENTICAÇÃO SIMPLES
   ============================================================ */

app.post("/api/auth/register", async (req, res) => {
  const {
    username,
    displayName,
    email,
    password,
    avatarEmoji
  } = req.body;

  if (!username || !displayName || !password) {
    return res.status(400).json({
      ok: false,
      message: "Informe username, displayName e password."
    });
  }

  if (String(username).trim().length < 3) {
    return res.status(400).json({
      ok: false,
      message: "O nome de usuário precisa ter pelo menos 3 caracteres."
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

    const result = await pool.query(
      `
      INSERT INTO public.app_users (
        username,
        display_name,
        email,
        password_hash,
        login_provider,
        avatar_type,
        avatar_emoji,
        is_guest,
        metadata
      )
      VALUES ($1, $2, $3, $4, 'EMAIL', 'EMOJI', $5, false, '{}'::jsonb)
      RETURNING
        id,
        username,
        display_name,
        email,
        avatar_type,
        avatar_url,
        avatar_key,
        avatar_color,
        avatar_emoji,
        role,
        is_guest,
        is_active,
        is_banned,
        created_at;
      `,
      [
        username.trim(),
        displayName.trim(),
        email || null,
        passwordHash,
        avatarEmoji || "🃏"
      ]
    );

    const user = result.rows[0];
    const token = signToken(user);

    res.json({
      ok: true,
      message: "Usuário cadastrado com sucesso.",
      token,
      user: publicUser(user)
    });
  } catch (error) {
    console.error("Erro ao cadastrar usuário:", error);

    if (error.code === "23505") {
      return res.status(409).json({
        ok: false,
        message: "Usuário ou e-mail já cadastrado."
      });
    }

    res.status(500).json({
      ok: false,
      message: "Erro ao cadastrar usuário.",
      error: error.message
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { login, password } = req.body;

  if (!login || !password) {
    return res.status(400).json({
      ok: false,
      message: "Informe login e password."
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
        avatar_url,
        avatar_key,
        avatar_color,
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
        message: "Usuário inativo ou bloqueado."
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
      SET
        last_login_at = now(),
        last_seen_at = now()
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
    console.error("Erro no login:", error);

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
        avatar_url,
        avatar_key,
        avatar_color,
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
   USUÁRIOS
   ============================================================ */

app.get("/api/users", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        username,
        display_name,
        email,
        avatar_type,
        avatar_url,
        avatar_key,
        avatar_color,
        avatar_emoji,
        is_guest,
        is_active,
        is_banned,
        created_at
      FROM public.app_users
      ORDER BY created_at DESC;
    `);

    res.json({
      ok: true,
      total: result.rows.length,
      users: result.rows
    });
  } catch (error) {
    console.error("Erro ao listar usuários:", error);

    res.status(500).json({
      ok: false,
      message: "Erro ao listar usuários.",
      error: error.message
    });
  }
});

/* ============================================================
   CARTEIRAS
   ============================================================ */

app.get("/api/wallets/me", authRequired, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        w.*,
        gt.name AS table_name
      FROM public.wallets w
      LEFT JOIN public.game_tables gt
        ON gt.id = w.table_id
      WHERE w.user_id = $1
      ORDER BY w.created_at DESC;
      `,
      [req.auth.sub]
    );

    res.json({
      ok: true,
      total: result.rows.length,
      wallets: result.rows
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: "Erro ao listar carteiras.",
      error: error.message
    });
  }
});

/* ============================================================
   MESAS
   ============================================================ */

app.post("/api/tables", authRequired, async (req, res) => {
  const {
    name,
    description,
    maxPlayers,
    initialChips
  } = req.body;

  if (!name) {
    return res.status(400).json({
      ok: false,
      message: "Informe o nome da mesa."
    });
  }

  const ownerUserId = req.auth.sub;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const tableResult = await client.query(
      `
      INSERT INTO public.game_tables (
        owner_user_id,
        name,
        description,
        max_players,
        initial_chips,
        visibility,
        status
      )
      VALUES ($1, $2, $3, $4, $5, 'LINK_ONLY', 'WAITING')
      RETURNING *;
      `,
      [
        ownerUserId,
        name.trim(),
        description || null,
        maxPlayers || 6,
        initialChips || 50
      ]
    );

    const table = tableResult.rows[0];

    const memberResult = await client.query(
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
      VALUES ($1, $2, 1, 'OWNER', 'WAITING', true, true)
      RETURNING *;
      `,
      [table.id, ownerUserId]
    );

    const ownerMember = await getMemberWithWallet(client, memberResult.rows[0].id);

    await client.query(
      `
      INSERT INTO public.hand_events (
        table_id,
        actor_user_id,
        event_type,
        action_type,
        public_message,
        is_public_log,
        payload
      )
      VALUES (
        $1,
        $2,
        'TABLE_CREATED',
        'CRIAR_MESA',
        'Mesa criada.',
        true,
        jsonb_build_object('table_name', $3)
      );
      `,
      [table.id, ownerUserId, table.name]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      message: "Mesa criada com sucesso.",
      table,
      ownerMember
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Erro ao criar mesa:", error);

    res.status(500).json({
      ok: false,
      message: "Erro ao criar mesa.",
      error: error.message
    });
  } finally {
    client.release();
  }
});

app.get("/api/tables", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        gt.id,
        gt.name,
        gt.description,
        gt.table_code,
        gt.invite_code,
        gt.visibility,
        gt.status,
        gt.min_players,
        gt.max_players,
        gt.initial_chips,
        gt.created_at,
        gt.owner_user_id,
        au.display_name AS owner_name,
        COUNT(tm.id)::int AS members_count
      FROM public.game_tables gt
      JOIN public.app_users au
        ON au.id = gt.owner_user_id
      LEFT JOIN public.table_members tm
        ON tm.table_id = gt.id
       AND tm.status <> 'LEFT'
      GROUP BY
        gt.id,
        au.display_name
      ORDER BY gt.created_at DESC;
    `);

    res.json({
      ok: true,
      total: result.rows.length,
      tables: result.rows
    });
  } catch (error) {
    console.error("Erro ao listar mesas:", error);

    res.status(500).json({
      ok: false,
      message: "Erro ao listar mesas.",
      error: error.message
    });
  }
});

app.post("/api/tables/:tableId/join", authRequired, async (req, res) => {
  const { tableId } = req.params;
  const { seatNumber } = req.body;

  const userId = req.auth.sub;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

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
        message: "Jogador já estava na mesa.",
        member: existing.rows[0]
      });
    }

    let finalSeatNumber = seatNumber || null;

    if (!finalSeatNumber) {
      const seatResult = await client.query(
        `
        SELECT COALESCE(MAX(seat_number), 0) + 1 AS next_seat
        FROM public.table_members
        WHERE table_id = $1
          AND seat_number IS NOT NULL;
        `,
        [tableId]
      );

      finalSeatNumber = seatResult.rows[0].next_seat;
    }

    const memberResult = await client.query(
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
      [tableId, userId, finalSeatNumber]
    );

    const member = await getMemberWithWallet(client, memberResult.rows[0].id);

    await client.query(
      `
      INSERT INTO public.hand_events (
        table_id,
        actor_user_id,
        event_type,
        action_type,
        public_message,
        is_public_log,
        payload
      )
      VALUES (
        $1,
        $2,
        'PLAYER_JOINED',
        'ENTRAR_MESA',
        'Jogador entrou na mesa.',
        true,
        '{}'::jsonb
      );
      `,
      [tableId, userId]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      message: "Jogador entrou na mesa.",
      member
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Erro ao entrar na mesa:", error);

    res.status(500).json({
      ok: false,
      message: "Erro ao entrar na mesa.",
      error: error.message
    });
  } finally {
    client.release();
  }
});

app.get("/api/tables/:tableId/members", async (req, res) => {
  const { tableId } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT *
      FROM public.vw_saldo_jogador_mesa
      WHERE table_id = $1
      ORDER BY seat_number NULLS LAST, joined_at ASC;
      `,
      [tableId]
    );

    res.json({
      ok: true,
      total: result.rows.length,
      members: result.rows
    });
  } catch (error) {
    console.error("Erro ao listar membros da mesa:", error);

    res.status(500).json({
      ok: false,
      message: "Erro ao listar membros da mesa.",
      error: error.message
    });
  }
});

/* ============================================================
   FICHAS
   ============================================================ */

app.post("/api/chips/add", authRequired, async (req, res) => {
  const {
    toWalletId,
    amount,
    description
  } = req.body;

  if (!toWalletId || !amount) {
    return res.status(400).json({
      ok: false,
      message: "Informe toWalletId e amount."
    });
  }

  try {
    const result = await pool.query(
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
        $5
      )
      RETURNING *;
      `,
      [
        SYSTEM_WALLET_ID,
        toWalletId,
        amount,
        req.auth.sub,
        description || "Adição administrativa de fichas."
      ]
    );

    res.json({
      ok: true,
      message: "Fichas adicionadas com sucesso.",
      transaction: result.rows[0]
    });
  } catch (error) {
    console.error("Erro ao adicionar fichas:", error);

    res.status(500).json({
      ok: false,
      message: "Erro ao adicionar fichas.",
      error: error.message
    });
  }
});

app.post("/api/chips/transfer", authRequired, async (req, res) => {
  const {
    fromWalletId,
    toWalletId,
    amount,
    description
  } = req.body;

  if (!fromWalletId || !toWalletId || !amount) {
    return res.status(400).json({
      ok: false,
      message: "Informe fromWalletId, toWalletId e amount."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const sourceWallet = await client.query(
      `
      SELECT *
      FROM public.wallets
      WHERE id = $1
        AND user_id = $2
      LIMIT 1;
      `,
      [fromWalletId, req.auth.sub]
    );

    if (!sourceWallet.rows[0]) {
      throw new Error("Carteira de origem não pertence ao usuário logado.");
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
        'PLAYER_TRANSFER',
        $1,
        $2,
        $3,
        'COMPLETED',
        $4,
        $4,
        $4,
        $5
      )
      RETURNING *;
      `,
      [
        fromWalletId,
        toWalletId,
        amount,
        req.auth.sub,
        description || "Transferência entre jogadores."
      ]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      message: "Transferência realizada com sucesso.",
      transaction: tx.rows[0]
    });
  } catch (error) {
    await client.query("ROLLBACK");

    res.status(500).json({
      ok: false,
      message: "Erro ao transferir fichas.",
      error: error.message
    });
  } finally {
    client.release();
  }
});

app.get("/api/chips/trace", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM public.vw_rastreio_fichas
      ORDER BY created_at DESC
      LIMIT 100;
    `);

    res.json({
      ok: true,
      total: result.rows.length,
      transactions: result.rows
    });
  } catch (error) {
    console.error("Erro ao rastrear fichas:", error);

    res.status(500).json({
      ok: false,
      message: "Erro ao rastrear fichas.",
      error: error.message
    });
  }
});

/* ============================================================
   DEMO CORRIGIDO
   ============================================================ */

app.get("/api/demo/create", async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const suffix = Date.now().toString().slice(-6);

    const passwordHash = await bcrypt.hash("123456", 10);

    const user1 = await client.query(
      `
      INSERT INTO public.app_users (
        username,
        display_name,
        password_hash,
        login_provider,
        avatar_type,
        avatar_emoji,
        is_guest
      )
      VALUES ($1, $2, $3, 'EMAIL', 'EMOJI', '🂡', false)
      RETURNING *;
      `,
      [`jogador_${suffix}_1`, `Jogador ${suffix} A`, passwordHash]
    );

    const user2 = await client.query(
      `
      INSERT INTO public.app_users (
        username,
        display_name,
        password_hash,
        login_provider,
        avatar_type,
        avatar_emoji,
        is_guest
      )
      VALUES ($1, $2, $3, 'EMAIL', 'EMOJI', '🃏', false)
      RETURNING *;
      `,
      [`jogador_${suffix}_2`, `Jogador ${suffix} B`, passwordHash]
    );

    const table = await client.query(
      `
      INSERT INTO public.game_tables (
        owner_user_id,
        name,
        description,
        max_players,
        initial_chips,
        visibility,
        status
      )
      VALUES ($1, $2, 'Mesa criada por teste automático corrigido.', 6, 50, 'LINK_ONLY', 'WAITING')
      RETURNING *;
      `,
      [user1.rows[0].id, `Mesa Teste ${suffix}`]
    );

    const member1 = await client.query(
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
      VALUES ($1, $2, 1, 'OWNER', 'WAITING', true, true)
      RETURNING *;
      `,
      [table.rows[0].id, user1.rows[0].id]
    );

    const member2 = await client.query(
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
      VALUES ($1, $2, 2, 'PLAYER', 'WAITING', true, false)
      RETURNING *;
      `,
      [table.rows[0].id, user2.rows[0].id]
    );

    const wallet1 = await getTableWallet(client, table.rows[0].id, user1.rows[0].id);
    const wallet2 = await getTableWallet(client, table.rows[0].id, user2.rows[0].id);

    if (!wallet1 || !wallet2) {
      throw new Error("Carteira da mesa não foi criada automaticamente.");
    }

    const tx1 = await client.query(
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
        50,
        'COMPLETED',
        $3,
        $3,
        $3,
        'Crédito inicial de teste.'
      )
      RETURNING *;
      `,
      [SYSTEM_WALLET_ID, wallet1.id, SYSTEM_USER_ID]
    );

    const tx2 = await client.query(
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
        50,
        'COMPLETED',
        $3,
        $3,
        $3,
        'Crédito inicial de teste.'
      )
      RETURNING *;
      `,
      [SYSTEM_WALLET_ID, wallet2.id, SYSTEM_USER_ID]
    );

    await client.query(
      `
      INSERT INTO public.hand_events (
        table_id,
        actor_user_id,
        event_type,
        action_type,
        public_message,
        is_public_log,
        payload
      )
      VALUES (
        $1,
        $2,
        'TABLE_CREATED',
        'CRIAR_MESA',
        'Mesa de teste criada com dois jogadores.',
        true,
        jsonb_build_object('demo', true)
      );
      `,
      [table.rows[0].id, user1.rows[0].id]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      message: "Demonstração criada com sucesso. Senha dos usuários demo: 123456",
      user1: publicUser(user1.rows[0]),
      user2: publicUser(user2.rows[0]),
      table: table.rows[0],
      member1: member1.rows[0],
      member2: member2.rows[0],
      wallet1,
      wallet2,
      transaction1: tx1.rows[0],
      transaction2: tx2.rows[0]
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Erro no demo:", error);

    res.status(500).json({
      ok: false,
      message: "Erro ao criar demonstração.",
      error: error.message
    });
  } finally {
    client.release();
  }
});

/* ============================================================
   SOCKET.IO
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

  socket.on("criar_mesa", (dados) => {
    console.log("Mesa criada via socket:", dados);

    socket.emit("mesa_criada", {
      idMesa: "mesa-teste",
      nome: dados?.nome || "Mesa de Teste"
    });
  });

  socket.on("entrar_mesa", (dados) => {
    console.log("Jogador entrou na mesa via socket:", dados);

    socket.join(dados.idMesa);

    io.to(dados.idMesa).emit("jogador_entrou", {
      idJogador: socket.id,
      nome: dados?.nome || "Jogador"
    });
  });

  socket.on("disconnect", () => {
    console.log("Jogador desconectado:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Servidor Lu Online rodando na porta ${PORT}`);
});
