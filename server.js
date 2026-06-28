const express = require("express");
const http = require("http");
const cors = require("cors");
const { Pool } = require("pg");
const { Server } = require("socket.io");

const app = express();

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000001";
const SYSTEM_WALLET_ID = "00000000-0000-0000-0000-000000000002";

/* ============================================================
   ROTAS BÁSICAS
   ============================================================ */

app.get("/", (req, res) => {
  res.json({
    status: "online",
    app: "Lu Online",
    message: "Backend inicial funcionando no Render",
    databaseConfigured: Boolean(process.env.DATABASE_URL)
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "loo-api",
    databaseConfigured: Boolean(process.env.DATABASE_URL)
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
   USUÁRIOS
   ============================================================ */

app.post("/api/users", async (req, res) => {
  const { username, displayName, email, avatarEmoji } = req.body;

  if (!username || !displayName) {
    return res.status(400).json({
      ok: false,
      message: "Informe username e displayName."
    });
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO public.app_users (
        username,
        display_name,
        email,
        login_provider,
        avatar_type,
        avatar_emoji,
        is_guest,
        metadata
      )
      VALUES ($1, $2, $3, 'GUEST', 'EMOJI', $4, true, '{}'::jsonb)
      RETURNING
        id,
        username,
        display_name,
        email,
        avatar_type,
        avatar_emoji,
        created_at;
      `,
      [username, displayName, email || null, avatarEmoji || "🃏"]
    );

    res.json({
      ok: true,
      message: "Jogador criado com sucesso.",
      user: result.rows[0]
    });
  } catch (error) {
    console.error("Erro ao criar usuário:", error);

    res.status(500).json({
      ok: false,
      message: "Erro ao criar jogador.",
      error: error.message
    });
  }
});

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
   MESAS
   ============================================================ */

app.post("/api/tables", async (req, res) => {
  const {
    ownerUserId,
    name,
    description,
    maxPlayers,
    initialChips
  } = req.body;

  if (!ownerUserId || !name) {
    return res.status(400).json({
      ok: false,
      message: "Informe ownerUserId e name."
    });
  }

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
        name,
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
      ownerMember: memberResult.rows[0]
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
        au.display_name AS owner_name
      FROM public.game_tables gt
      JOIN public.app_users au
        ON au.id = gt.owner_user_id
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

app.post("/api/tables/:tableId/join", async (req, res) => {
  const { tableId } = req.params;
  const { userId, seatNumber } = req.body;

  if (!userId) {
    return res.status(400).json({
      ok: false,
      message: "Informe userId."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

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
      [tableId, userId, seatNumber || null]
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
      member: memberResult.rows[0]
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

app.post("/api/chips/add", async (req, res) => {
  const {
    toWalletId,
    amount,
    description,
    createdByUserId
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
        createdByUserId || SYSTEM_USER_ID,
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
   TESTE AUTOMÁTICO DE DEMONSTRAÇÃO
   Cria 2 jogadores, 1 mesa e adiciona fichas.
   Depois podemos remover essa rota.
   ============================================================ */

app.get("/api/demo/create", async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const suffix = Date.now().toString().slice(-6);

    const user1 = await client.query(
      `
      INSERT INTO public.app_users (
        username,
        display_name,
        login_provider,
        avatar_type,
        avatar_emoji,
        is_guest
      )
      VALUES ($1, $2, 'GUEST', 'EMOJI', '🂡', true)
      RETURNING *;
      `,
      [`jogador_${suffix}_1`, `Jogador ${suffix} A`]
    );

    const user2 = await client.query(
      `
      INSERT INTO public.app_users (
        username,
        display_name,
        login_provider,
        avatar_type,
        avatar_emoji,
        is_guest
      )
      VALUES ($1, $2, 'GUEST', 'EMOJI', '🃏', true)
      RETURNING *;
      `,
      [`jogador_${suffix}_2`, `Jogador ${suffix} B`]
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
      VALUES ($1, $2, 'Mesa criada por teste automático.', 6, 50, 'LINK_ONLY', 'WAITING')
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

    const wallet1 = await client.query(
      `
      SELECT *
      FROM public.wallets
      WHERE id = $1;
      `,
      [member1.rows[0].table_wallet_id]
    );

    const wallet2 = await client.query(
      `
      SELECT *
      FROM public.wallets
      WHERE id = $1;
      `,
      [member2.rows[0].table_wallet_id]
    );

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
      [SYSTEM_WALLET_ID, wallet1.rows[0].id, SYSTEM_USER_ID]
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
      [SYSTEM_WALLET_ID, wallet2.rows[0].id, SYSTEM_USER_ID]
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
      message: "Demonstração criada com sucesso.",
      user1: user1.rows[0],
      user2: user2.rows[0],
      table: table.rows[0],
      member1: member1.rows[0],
      member2: member2.rows[0],
      wallet1: wallet1.rows[0],
      wallet2: wallet2.rows[0],
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
