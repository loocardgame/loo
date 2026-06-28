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
    console.log("Mesa criada:", dados);

    socket.emit("mesa_criada", {
      idMesa: "mesa-teste",
      nome: dados?.nome || "Mesa de Teste"
    });
  });

  socket.on("entrar_mesa", (dados) => {
    console.log("Jogador entrou na mesa:", dados);

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
