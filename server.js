const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    status: "online",
    app: "Lu Online",
    message: "Backend inicial funcionando no Render"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "loo-api"
  });
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
