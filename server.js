const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, "public")));

const queue = [];
const clients = new Map();

function send(socket, data) {
  if (socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(data));
    } catch (error) {
      console.error(
        `კლიენტთან შეტყობინების გაგზავნის შეცდომა ${socket.id}:`,
        error
      );
    }
  }
}

function isCompatible(clientA, clientB) {
  const aData = clients.get(clientA);
  const bData = clients.get(clientB);

  if (!aData || !bData) {
    console.log(`Client data missing: clientA=${!!aData}, clientB=${!!bData}`);
    return false;
  }

  if (aData.partnerGender !== "any" && aData.partnerGender !== bData.myGender) {
    return false;
  }
  if (bData.partnerGender !== "any" && bData.partnerGender !== aData.myGender) {
    return false;
  }

  if (!bData.partnerAges.includes(aData.myAge)) {
    return false;
  }
  if (!aData.partnerAges.includes(bData.myAge)) {
    return false;
  }

  return true;
}

function unpair(clientId) {
  console.log(`Unpairing client ${clientId}`);
  const client = clients.get(clientId);
  if (!client) {
    console.log(`Client ${clientId} not found in clients during unpair`);
    return;
  }

  const partnerId = client.partnerId;
  if (partnerId && clients.has(partnerId)) {
    const partner = clients.get(partnerId);
    console.log(`Notifying partner ${partnerId} of disconnection`);
    partner.partnerId = null;
    if (partner.socket.readyState === WebSocket.OPEN) {
      send(partner.socket, { type: "partner-disconnected" });
    } else {
      console.log(
        `Partner ${partnerId} socket is closed, removing from clients`
      );
      clients.delete(partnerId);
    }
  }

  client.partnerId = null;
  client.myGender = null;
  client.myAge = null;
  client.partnerGender = null;
  client.partnerAges = [];
  console.log(`Client ${clientId} state reset`);
}

function pairClients(clientA, clientB) {
  if (!clientA || !clientB || !clients.has(clientA) || !clients.has(clientB)) {
    console.warn("შეუძლებელია კლიენტების დაკავშირება:", clientA, clientB);
    return;
  }

  clients.get(clientA).partnerId = clientB;
  clients.get(clientB).partnerId = clientA;

  send(clients.get(clientA).socket, { type: "match", peerId: clientB });
  send(clients.get(clientB).socket, { type: "match", peerId: clientA });
  console.log(`კლიენტები დაუკავშირდნენ ერთმანეთს: ${clientA} და ${clientB}`);

  const indexA = queue.indexOf(clientA);
  const indexB = queue.indexOf(clientB);
  if (indexA !== -1) queue.splice(indexA, 1);
  if (indexB !== -1) queue.splice(indexB, 1);
  console.log(`Queue after pairing:`, queue);
}

wss.on("connection", (ws) => {
  const clientId = uuidv4();
  clients.set(clientId, {
    socket: ws,
    partnerId: null,
    myGender: null,
    myAge: null,
    partnerGender: null,
    partnerAges: [],
  });
  ws.id = clientId;

  console.log(`ახალი კლიენტი დაკავშირდა: ${clientId}`);

  ws.on("message", (message) => {
    console.log(`Received message from ${clientId}: ${message}`);
    let data;
    try {
      data = JSON.parse(message.toString());
    } catch (error) {
      console.error(`არაკორექტული JSON კლიენტისგან ${clientId}:`, error);
      return;
    }

    if (data.type === "ready") {
      const clientData = clients.get(clientId);
      if (!clientData) {
        console.error(`Client ${clientId} not found in clients during ready`);
        return;
      }

      if (clientData.partnerId) {
        console.log(
          `Client ${clientId} is already paired with ${clientData.partnerId}, ignoring ready message`
        );
        send(ws, { type: "waiting" });
        return;
      }

      clientData.myGender = data.myGender;
      clientData.myAge = data.myAge;
      clientData.partnerGender = data.partnerGender;
      clientData.partnerAges = data.partnerAges;

      const queueIndex = queue.indexOf(clientId);
      if (queueIndex !== -1) {
        queue.splice(queueIndex, 1);
        console.log(`Client ${clientId} removed from queue before re-adding`);
      }

      queue.push(clientId);
      console.log(`Client ${clientId} added to queue. Queue:`, queue);

      let paired = false;
      for (let i = queue.length - 1; i >= 0; i--) {
        const partnerId = queue[i];
        if (clientId === partnerId) continue;

        if (!clients.has(partnerId)) {
          console.log(
            `Client ${partnerId} in queue but not in clients, removing from queue`
          );
          queue.splice(i, 1);
          continue;
        }

        const partnerData = clients.get(partnerId);
        if (partnerData.partnerId) {
          console.log(
            `Client ${partnerId} is already paired, removing from queue`
          );
          queue.splice(i, 1);
          continue;
        }

        if (isCompatible(clientId, partnerId)) {
          queue.splice(i, 1);
          queue.splice(queue.indexOf(clientId), 1);
          pairClients(clientId, partnerId);
          paired = true;
          break;
        }
      }

      if (!paired) {
        console.log(`No pair found for ${clientId}, waiting...`);
        send(ws, { type: "waiting" });
      }
      return;
    }

    if (data.type === "disconnect") {
      console.log(`Client ${clientId} requested disconnect`);
      unpair(clientId);

      const index = queue.indexOf(clientId);
      if (index !== -1) {
        queue.splice(index, 1);
        console.log(`Client ${clientId} removed from queue on disconnect`);
      }
      return;
    }

    const partnerId = clients.get(clientId)?.partnerId;
    if (partnerId && clients.has(partnerId)) {
      const partner = clients.get(partnerId);
      if (partner.socket.readyState === WebSocket.OPEN) {
        console.log(`Forwarding ${data.type} from ${clientId} to ${partnerId}`);
        send(partner.socket, data);
      } else {
        console.log(`Partner ${partnerId} socket is closed, unpairing`);
        unpair(clientId);
      }
    } else {
      console.log(`No partner found for ${clientId} to forward ${data.type}`);
    }
  });

  ws.on("close", () => {
    console.log(`კლიენტი გაითიშა: ${clientId}`);
    unpair(clientId);

    const index = queue.indexOf(clientId);
    if (index !== -1) {
      queue.splice(index, 1);
      console.log(`Client ${clientId} removed from queue on close`);
    }

    clients.delete(clientId);
    console.log(`Client ${clientId} removed from clients on close`);
  });

  ws.on("error", (error) => {
    console.error(`შეცდომა WebSocket კლიენტისთვის ${clientId}:`, error);
    unpair(clientId);

    const index = queue.indexOf(clientId);
    if (index !== -1) {
      queue.splice(index, 1);
      console.log(`Client ${clientId} removed from queue on error`);
    }

    clients.delete(clientId);
    console.log(`Client ${clientId} removed from clients on error`);
  });
});

setInterval(() => {
  for (const [id, client] of clients) {
    if (client.socket.readyState === WebSocket.CLOSED) {
      console.log(`Cleaning up inactive client ${id}`);
      unpair(id);
      const index = queue.indexOf(id);
      if (index !== -1) {
        queue.splice(index, 1);
        console.log(`Client ${id} removed from queue during cleanup`);
      }
      clients.delete(id);
      console.log(`Client ${id} removed from clients during cleanup`);
    }
  }
}, 60000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`სერვერი მუშაობს http://0.0.0.0:${PORT}`);
});
