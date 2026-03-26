const crypto = require("node:crypto");
const http = require("node:http");
const { WebSocket, WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 10000);
const TICK_RATE = 60;
const SNAPSHOT_EVERY_TICKS = 3;
const ROUND_RESET_MS = 1800;
const INVITE_TIMEOUT_MS = 10000;

const WORLD_WIDTH = 7200;
const WORLD_HEIGHT = 5200;
const ARENA = { x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2, radius: 336 };
const PLAYER_RADIUS = 46;
const PLAYER_SPEED = 150;
const BOOST_MULTIPLIER = 1.95;
const BOOST_BURST_MS = 90;
const BOOST_COOLDOWN_MS = 3000;
const BOOST_IMPULSE = 120;
const BOOST_STEP_DISTANCE = 8;
const BOOST_WATER_COST = 14;
const POINTER_FORCE_RADIUS = 240;
const NORMAL_FORCE = 560;
const BOOST_FORCE = 860;
const NORMAL_FRICTION = 2.25;
const BOOST_FRICTION = 1.2;
const TURN_SPEED = 4.125;
const WATER_REGEN_PER_SECOND = 8;
const WATER_BOOST_DRAIN_PER_SECOND = 16;
const PACKET_POINTER = 0x05;
const PACKET_RESIZE = 0x11;
const PACKET_SECONDARY = 0x14;
const PACKET_BOOST = 0x15;
const PACKET_INVITE_1V1 = 0x34;
const BITE_CONTACT_RANGE = 58;
const BITE_DAMAGE = 10;
const BITE_COOLDOWN = 0.42;
const ROOM_MIN_ARENA_RADIUS = 180;
const ROOM_SHRINK_PER_SECOND = 4.5;
const ARENA_BURN_DAMAGE_PER_SECOND = 3;

const clients = new Map();
const rooms = new Map();
let tickCounter = 0;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function approach(current, target, sharpness, dt) {
  return current + (target - current) * (1 - Math.exp(-sharpness * dt));
}

function normalize(x, y) {
  const length = Math.hypot(x, y);
  if (!length) {
    return { x: 0, y: 0, length: 0 };
  }

  return {
    x: x / length,
    y: y / length,
    length
  };
}

function shortestAngleDelta(from, to) {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) {
    delta -= Math.PI * 2;
  } else if (delta < -Math.PI) {
    delta += Math.PI * 2;
  }
  return delta;
}

function directionTowardTarget(fromX, fromY, toX, toY, fallbackAngle = 0) {
  const direction = normalize(toX - fromX, toY - fromY);
  if (direction.length > 0.001) {
    return direction;
  }

  return {
    x: Math.cos(fallbackAngle),
    y: Math.sin(fallbackAngle),
    length: 1
  };
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function sanitizeName(value) {
  const trimmed = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 18);

  return trimmed || "Dragon";
}

function createDragon(seed = {}) {
  return {
    name: seed.name || "Dragon",
    x: Number.isFinite(seed.x) ? seed.x : ARENA.x - ARENA.radius * 0.42,
    y: Number.isFinite(seed.y) ? seed.y : ARENA.y,
    vx: Number.isFinite(seed.vx) ? seed.vx : 0,
    vy: Number.isFinite(seed.vy) ? seed.vy : 0,
    angle: Number.isFinite(seed.angle) ? seed.angle : 0,
    radius: Number.isFinite(seed.radius) ? seed.radius : PLAYER_RADIUS,
    health: Number.isFinite(seed.health) ? seed.health : 100,
    maxHealth: Number.isFinite(seed.maxHealth) ? seed.maxHealth : 100,
    water: Number.isFinite(seed.water) ? seed.water : 100,
    maxWater: Number.isFinite(seed.maxWater) ? seed.maxWater : 100,
    baseSpeed: Number.isFinite(seed.baseSpeed) ? seed.baseSpeed : PLAYER_SPEED,
    boosting: false,
    boostVisual: Number.isFinite(seed.boostVisual) ? seed.boostVisual : 0,
    healVisual: Number.isFinite(seed.healVisual) ? seed.healVisual : 0
  };
}

function socketIsOpen(client) {
  return client && client.ws && client.ws.readyState === WebSocket.OPEN;
}

function spawnPracticeDragon(client) {
  client.dragon = createDragon({
    name: client.name,
    x: ARENA.x - ARENA.radius * 0.42,
    y: ARENA.y,
    angle: 0
  });
  client.dead = false;
  client.targetX = client.dragon.x + 120;
  client.targetY = client.dragon.y;
  client.boostActiveUntil = 0;
  client.boostCooldownUntil = 0;
  client.secondary = false;
  client.biteCooldown = 0;
  client.roundBites = 0;
}

function opponentFor(client) {
  if (!client.roomId) {
    return null;
  }

  const room = rooms.get(client.roomId);
  if (!room) {
    return null;
  }

  return room.players[0] === client ? room.players[1] : room.players[0];
}

function previewOpponentFor(client) {
  const preferredId = client.incomingInviteFrom || client.outgoingInviteTo;
  if (preferredId) {
    const preferred = clients.get(preferredId);
    if (preferred && preferred !== client && socketIsOpen(preferred) && !preferred.roomId) {
      return preferred;
    }
  }

  for (const candidate of clients.values()) {
    if (
      candidate === client ||
      !socketIsOpen(candidate) ||
      candidate.dead ||
      candidate.roomId ||
      candidate.incomingInviteFrom ||
      candidate.outgoingInviteTo
    ) {
      continue;
    }

    return candidate;
  }

  for (const candidate of clients.values()) {
    if (candidate === client || !socketIsOpen(candidate) || candidate.dead || candidate.roomId) {
      continue;
    }

    return candidate;
  }

  return null;
}

function spawnRoom(room) {
  const [left, right] = room.players;

  left.dragon = createDragon({
    name: left.name,
    x: ARENA.x - ARENA.radius * 0.42,
    y: ARENA.y,
    angle: 0
  });
  right.dragon = createDragon({
    name: right.name,
    x: ARENA.x + ARENA.radius * 0.42,
    y: ARENA.y,
    angle: Math.PI
  });

  for (const client of room.players) {
    client.targetX = client.dragon.x + Math.cos(client.dragon.angle) * 120;
    client.targetY = client.dragon.y + Math.sin(client.dragon.angle) * 120;
    client.boostActiveUntil = 0;
    client.boostCooldownUntil = 0;
    client.secondary = false;
    client.biteCooldown = 0;
    client.roundBites = 0;
    client.outgoingInviteTo = null;
    client.incomingInviteFrom = null;
    client.inviteExpiresAt = 0;
  }
}

function clearInvitePair(inviter, target, inviterStatus = null, targetStatus = null) {
  if (inviter) {
    inviter.outgoingInviteTo = null;
    inviter.inviteExpiresAt = 0;
    if (inviterStatus) {
      inviter.status = inviterStatus;
    }
  }

  if (target) {
    target.incomingInviteFrom = null;
    target.inviteExpiresAt = 0;
    if (targetStatus) {
      target.status = targetStatus;
    }
  }

  if (inviter && socketIsOpen(inviter)) {
    sendSnapshot(inviter);
  }

  if (target && socketIsOpen(target)) {
    sendSnapshot(target);
  }
}

function clearClientInvites(client, status = null) {
  if (client.outgoingInviteTo) {
    const target = clients.get(client.outgoingInviteTo);
    clearInvitePair(
      client,
      target,
      status,
      target && !target.roomId ? "Practice mode live." : null
    );
    return;
  }

  if (client.incomingInviteFrom) {
    const inviter = clients.get(client.incomingInviteFrom);
    clearInvitePair(
      inviter,
      client,
      inviter && !inviter.roomId ? "Practice mode live." : null,
      status
    );
    return;
  }

  if (status) {
    client.status = status;
    sendSnapshot(client);
  }
}

function startLiveArena(inviter, target) {
  if (!socketIsOpen(inviter) || !socketIsOpen(target) || inviter.roomId || target.roomId) {
    clearInvitePair(inviter, target, "Practice mode live.", "Practice mode live.");
    return;
  }

  const room = {
    id: crypto.randomUUID(),
    players: [inviter, target],
    state: "running",
    resetAt: 0,
    arenaRadius: ARENA.radius
  };

  inviter.roomId = room.id;
  target.roomId = room.id;
  inviter.status = "1v1 started. Right click or W to bite.";
  target.status = "1v1 started. Right click or W to bite.";
  spawnRoom(room);
  rooms.set(room.id, room);
  sendSnapshot(inviter);
  sendSnapshot(target);
}

function handleInvitePacket(client) {
  if (!socketIsOpen(client)) {
    return;
  }

  if (client.roomId) {
    client.status = "You are already inside a live 1v1 arena.";
    sendSnapshot(client);
    return;
  }

  if (client.incomingInviteFrom) {
    const inviter = clients.get(client.incomingInviteFrom);
    if (!inviter || inviter.outgoingInviteTo !== client.id) {
      clearClientInvites(client, "Practice mode live.");
      return;
    }

    startLiveArena(inviter, client);
    return;
  }

  if (client.outgoingInviteTo) {
    client.status = "Waiting for the other dragon to accept.";
    sendSnapshot(client);
    return;
  }

  const target = previewOpponentFor(client);
  if (!target) {
    client.status = "No other dragon is available right now.";
    sendSnapshot(client);
    return;
  }

  if (target.incomingInviteFrom || target.outgoingInviteTo) {
    client.status = "That dragon is busy right now.";
    sendSnapshot(client);
    return;
  }

  client.outgoingInviteTo = target.id;
  client.inviteExpiresAt = Date.now() + INVITE_TIMEOUT_MS;
  target.incomingInviteFrom = client.id;
  target.inviteExpiresAt = client.inviteExpiresAt;
  client.status = "1v1 request sent.";
  target.status = "Incoming 1v1 request.";
  sendSnapshot(client);
  sendSnapshot(target);
}

function expireInvites(now) {
  for (const client of clients.values()) {
    if (!client.outgoingInviteTo || !client.inviteExpiresAt || client.inviteExpiresAt > now) {
      continue;
    }

    const target = clients.get(client.outgoingInviteTo);
    clearInvitePair(client, target, "Invite expired.", target ? "Invite expired." : null);
  }
}

function clampToArena(dragon, arenaRadius = ARENA.radius) {
  const dx = dragon.x - ARENA.x;
  const dy = dragon.y - ARENA.y;
  const distance = Math.hypot(dx, dy) || 1;
  const limit = arenaRadius - dragon.radius - 8;

  if (distance > limit) {
    dragon.x = ARENA.x + (dx / distance) * limit;
    dragon.y = ARENA.y + (dy / distance) * limit;
    dragon.vx *= 0.28;
    dragon.vy *= 0.28;
  }

  dragon.x = clamp(dragon.x, dragon.radius, WORLD_WIDTH - dragon.radius);
  dragon.y = clamp(dragon.y, dragon.radius, WORLD_HEIGHT - dragon.radius);
}

function distanceToZone(entity, zone) {
  return Math.hypot(entity.x - zone.x, entity.y - zone.y);
}

function updateDragon(client, dt, arenaRadius = ARENA.radius) {
  const dragon = client.dragon;
  if (!dragon) {
    return;
  }

  dragon.name = client.name;
  const previousX = dragon.x;
  const previousY = dragon.y;
  const targetX = client.targetX;
  const targetY = client.targetY;
  const direction = normalize(targetX - dragon.x, targetY - dragon.y);
  const distance = direction.length;
  const now = Date.now();
  const wantsBoost = now < client.boostActiveUntil && dragon.water > 0.5;
  const maxSpeed = dragon.baseSpeed * (wantsBoost ? BOOST_MULTIPLIER : 1);
  const thrustScale = Math.min(1, Math.pow(clamp(distance / POINTER_FORCE_RADIUS, 0, 1), 2) * 1.15);
  const force = (wantsBoost ? BOOST_FORCE : NORMAL_FORCE) * thrustScale;
  const friction = wantsBoost ? BOOST_FRICTION : NORMAL_FRICTION;

  if (distance > 0.001) {
    dragon.vx += direction.x * force * dt;
    dragon.vy += direction.y * force * dt;
  }

  dragon.vx *= Math.exp(-friction * dt);
  dragon.vy *= Math.exp(-friction * dt);

  const speed = Math.hypot(dragon.vx, dragon.vy);
  if (speed > maxSpeed && speed > 0) {
    const scale = maxSpeed / speed;
    dragon.vx *= scale;
    dragon.vy *= scale;
  }

  dragon.x += dragon.vx * dt;
  dragon.y += dragon.vy * dt;
  dragon.vx = (dragon.x - previousX) / Math.max(dt, 0.0001);
  dragon.vy = (dragon.y - previousY) / Math.max(dt, 0.0001);

  if (distance > 0.001) {
    const targetAngle = Math.atan2(direction.y, direction.x);
    dragon.angle += shortestAngleDelta(dragon.angle, targetAngle) * Math.min(TURN_SPEED * dt, 1);
  }

  if (wantsBoost && distance > 0.001) {
    dragon.water = Math.max(0, dragon.water - WATER_BOOST_DRAIN_PER_SECOND * dt);
  }

  dragon.water = Math.min(dragon.maxWater, dragon.water + WATER_REGEN_PER_SECOND * dt);
  if (!wantsBoost) {
    client.boostActiveUntil = 0;
  }
  dragon.boosting = wantsBoost && speed > 10;
  dragon.boostVisual = approach(dragon.boostVisual, dragon.boosting ? 1 : 0, 10, dt);
  dragon.healVisual = approach(dragon.healVisual, 0, 9, dt);

  clampToArena(dragon, arenaRadius);
}

function mouthPointForDragon(dragon) {
  return {
    x: dragon.x + Math.cos(dragon.angle) * dragon.radius * 1.18,
    y: dragon.y + Math.sin(dragon.angle) * dragon.radius * 1.18
  };
}

function tailSegmentForDragon(dragon) {
  const dx = Math.cos(dragon.angle);
  const dy = Math.sin(dragon.angle);

  return {
    x1: dragon.x - dx * dragon.radius * 0.38,
    y1: dragon.y - dy * dragon.radius * 0.38,
    x2: dragon.x - dx * dragon.radius * 1.48,
    y2: dragon.y - dy * dragon.radius * 1.48
  };
}

function distancePointToSegment(px, py, x1, y1, x2, y2) {
  const segmentX = x2 - x1;
  const segmentY = y2 - y1;
  const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;

  if (segmentLengthSquared <= 0.0001) {
    return Math.hypot(px - x1, py - y1);
  }

  const projection = clamp(
    ((px - x1) * segmentX + (py - y1) * segmentY) / segmentLengthSquared,
    0,
    1
  );
  const nearestX = x1 + segmentX * projection;
  const nearestY = y1 + segmentY * projection;
  return Math.hypot(px - nearestX, py - nearestY);
}

function touchesArenaBoundary(dragon, arenaRadius) {
  const distance = Math.hypot(dragon.x - ARENA.x, dragon.y - ARENA.y);
  const limit = arenaRadius - dragon.radius - 8;
  return distance >= limit - 6;
}

function applyArenaBurn(client, arenaRadius, dt) {
  if (!client.dragon || client.dragon.health <= 0) {
    return;
  }

  if (!touchesArenaBoundary(client.dragon, arenaRadius)) {
    return;
  }

  client.dragon.health = Math.max(0, client.dragon.health - ARENA_BURN_DAMAGE_PER_SECOND * dt);
  client.status = "Arena burn is hitting you.";
}

function handleSoloDeath(client) {
  client.dead = true;
  client.status = "You died. Press Play to respawn.";
  client.boostActiveUntil = 0;
  client.boostCooldownUntil = 0;
  client.secondary = false;
  if (client.dragon) {
    client.dragon.health = 0;
  }
  clearClientInvites(client);
}

function tryBite(attacker, defender, dt) {
  if (
    !attacker.secondary ||
    attacker.biteCooldown > 0 ||
    !attacker.dragon ||
    !defender.dragon ||
    defender.dragon.health <= 0
  ) {
    return;
  }

  const mouth = mouthPointForDragon(attacker.dragon);
  const tail = tailSegmentForDragon(defender.dragon);
  const contactDistance = distancePointToSegment(
    mouth.x,
    mouth.y,
    tail.x1,
    tail.y1,
    tail.x2,
    tail.y2
  );

  if (contactDistance > BITE_CONTACT_RANGE) {
    return;
  }

  attacker.biteCooldown = BITE_COOLDOWN;
  attacker.roundBites += 1;
  defender.dragon.health = Math.max(0, defender.dragon.health - BITE_DAMAGE);
  attacker.status = "Tail bite landed.";
  defender.status = "Your tail was bitten.";
}

function finishRound(room, winner, loser) {
  winner.wins += 1;
  loser.losses += 1;
  winner.status = "Round won. Arena resetting...";
  loser.status = "Round lost. Arena resetting...";
  winner.boostActiveUntil = 0;
  loser.boostActiveUntil = 0;
  winner.secondary = false;
  loser.secondary = false;
  room.state = "resetting";
  room.resetAt = Date.now() + ROUND_RESET_MS;
}

function updateRoom(room, dt) {
  if (room.state === "resetting") {
    if (Date.now() >= room.resetAt) {
      spawnRoom(room);
      room.arenaRadius = ARENA.radius;
      room.state = "running";
      for (const client of room.players) {
        client.status = "New round started.";
      }
    }
    return;
  }

  const [left, right] = room.players;
  left.biteCooldown = Math.max(0, left.biteCooldown - dt);
  right.biteCooldown = Math.max(0, right.biteCooldown - dt);
  room.arenaRadius = Math.max(ROOM_MIN_ARENA_RADIUS, room.arenaRadius - ROOM_SHRINK_PER_SECOND * dt);
  updateDragon(left, dt, room.arenaRadius);
  updateDragon(right, dt, room.arenaRadius);
  applyArenaBurn(left, room.arenaRadius, dt);
  applyArenaBurn(right, room.arenaRadius, dt);
  tryBite(left, right, dt);
  tryBite(right, left, dt);

  if (left.dragon.health <= 0 || right.dragon.health <= 0) {
    const winner = left.dragon.health > 0 ? left : right;
    const loser = winner === left ? right : left;
    finishRound(room, winner, loser);
  }
}

function updateSoloClient(client, dt) {
  if (client.roomId) {
    return;
  }

  if (client.dead) {
    client.status = "You died. Press Play to respawn.";
    return;
  }

  client.biteCooldown = Math.max(0, client.biteCooldown - dt);
  updateDragon(client, dt);
  if (client.incomingInviteFrom) {
    client.status = "Incoming 1v1 request.";
  } else if (client.outgoingInviteTo) {
    client.status = "Waiting for the other dragon to accept.";
  } else {
    client.status = "Practice mode live.";
  }
}

function serializeDragon(dragon) {
  return {
    name: dragon.name,
    x: round1(dragon.x),
    y: round1(dragon.y),
    vx: round1(dragon.vx),
    vy: round1(dragon.vy),
    angle: round1(dragon.angle),
    radius: dragon.radius,
    health: round1(dragon.health),
    maxHealth: dragon.maxHealth,
    water: round1(dragon.water),
    maxWater: dragon.maxWater,
    baseSpeed: dragon.baseSpeed,
    biteCooldown: round1(dragon.biteCooldown || 0),
    biteCooldownMax: BITE_COOLDOWN,
    boosting: dragon.boosting,
    boostVisual: round1(dragon.boostVisual),
    healVisual: round1(dragon.healVisual)
  };
}

function updateSoloInteractions(dt) {
  const soloClients = [];
  for (const client of clients.values()) {
    if (!client.roomId && !client.dead && socketIsOpen(client) && client.dragon) {
      soloClients.push(client);
    }
  }

  for (let index = 0; index < soloClients.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < soloClients.length; otherIndex += 1) {
      const left = soloClients[index];
      const right = soloClients[otherIndex];
      tryBite(left, right, dt);
      tryBite(right, left, dt);
    }
  }

  for (const client of soloClients) {
    if (client.dragon.health <= 0) {
      handleSoloDeath(client);
    }
  }
}

function sendSnapshot(client) {
  if (!socketIsOpen(client) || !client.dragon) {
    return;
  }

  const room = client.roomId ? rooms.get(client.roomId) : null;
  const roomOpponent = opponentFor(client);
  const opponent = roomOpponent || previewOpponentFor(client);
  const payload = {
    type: "snapshot",
    status: client.status,
    phase: room ? "arena" : "practice",
    dead: client.dead === true,
    arenaRadius: room ? room.arenaRadius : ARENA.radius,
    incomingInvite: client.incomingInviteFrom != null,
    outgoingInvite: client.outgoingInviteTo != null,
    player: serializeDragon(client.dragon),
    opponent: opponent && opponent.dragon ? serializeDragon(opponent.dragon) : null,
    round: {
      wins: client.wins,
      losses: client.losses,
      bites: client.roundBites,
      opponentBites: roomOpponent ? roomOpponent.roundBites : 0
    }
  };

  client.ws.send(JSON.stringify(payload));
}

function cleanupClient(client) {
  if (!clients.has(client.id)) {
    return;
  }

  clearClientInvites(client);

  const room = client.roomId ? rooms.get(client.roomId) : null;
  if (room) {
    const opponent = room.players[0] === client ? room.players[1] : room.players[0];
    rooms.delete(room.id);
    if (opponent) {
      opponent.roomId = null;
      opponent.status = "Opponent left. Practice mode live.";
      spawnPracticeDragon(opponent);
      sendSnapshot(opponent);
    }
  }

  clients.delete(client.id);
}

function handlePacket(client, message) {
  const payload = Buffer.isBuffer(message) ? message : Buffer.from(message);
  if (payload.length < 1) {
    return;
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const code = view.getUint8(0);

  switch (code) {
    case PACKET_POINTER:
      if (view.byteLength >= 5) {
        client.targetX = clamp(view.getInt16(1, false), 0, WORLD_WIDTH);
        client.targetY = clamp(view.getInt16(3, false), 0, WORLD_HEIGHT);
      }
      break;
    case PACKET_BOOST:
      if (
        view.byteLength >= 2 &&
        view.getUint8(1) === 1 &&
        client.dragon &&
        client.dragon.water >= BOOST_WATER_COST &&
        Date.now() >= client.boostCooldownUntil
      ) {
        const now = Date.now();
        const direction = directionTowardTarget(
          client.dragon.x,
          client.dragon.y,
          client.targetX,
          client.targetY,
          client.dragon.angle
        );

        client.boostActiveUntil = now + BOOST_BURST_MS;
        client.boostCooldownUntil = now + BOOST_COOLDOWN_MS;
        client.dragon.x += direction.x * BOOST_STEP_DISTANCE;
        client.dragon.y += direction.y * BOOST_STEP_DISTANCE;
        client.dragon.vx += direction.x * BOOST_IMPULSE;
        client.dragon.vy += direction.y * BOOST_IMPULSE;
        client.dragon.water = Math.max(0, client.dragon.water - BOOST_WATER_COST);
        client.dragon.boosting = true;
        client.dragon.boostVisual = Math.max(client.dragon.boostVisual, 0.72);
        clampToArena(client.dragon);
      }
      break;
    case PACKET_SECONDARY:
      client.secondary = view.byteLength >= 2 && view.getUint8(1) === 1;
      break;
    case PACKET_INVITE_1V1:
      handleInvitePacket(client);
      break;
    case PACKET_RESIZE:
      break;
    default:
      break;
  }
}

function handleTextMessage(client, message) {
  let payload;

  try {
    payload = JSON.parse(message.toString());
  } catch (_error) {
    return;
  }

  if (!payload || !socketIsOpen(client)) {
    return;
  }

  if (payload.type === "set_name") {
    client.name = sanitizeName(payload.name);
    if (client.dragon) {
      client.dragon.name = client.name;
    }
    sendSnapshot(client);

    const opponent = opponentFor(client);
    if (opponent) {
      sendSnapshot(opponent);
    }
    return;
  }

  if (payload.type === "respawn") {
    if (!client.roomId) {
      spawnPracticeDragon(client);
      client.status = "Practice mode live.";
      sendSnapshot(client);
    }
    return;
  }

  if (payload.type !== "ping") {
    return;
  }

  client.ws.send(JSON.stringify({
    type: "pong",
    sentAt: Number.isFinite(payload.sentAt) ? payload.sentAt : Date.now()
  }));
}

const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, clients: clients.size, rooms: rooms.size }));
    return;
  }

  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      ok: true,
      name: "dragon-duel-server",
      message: "WebSocket arena server is running."
    })
  );
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  const client = {
    id: crypto.randomUUID(),
    ws,
    name: "Dragon",
    dead: false,
    roomId: null,
    status: "Practice mode live.",
    dragon: null,
    targetX: ARENA.x,
    targetY: ARENA.y,
    boostActiveUntil: 0,
    boostCooldownUntil: 0,
    secondary: false,
    incomingInviteFrom: null,
    outgoingInviteTo: null,
    inviteExpiresAt: 0,
    biteCooldown: 0,
    wins: 0,
    losses: 0,
    roundBites: 0
  };

  clients.set(client.id, client);
  spawnPracticeDragon(client);
  sendSnapshot(client);

  ws.on("message", (message, isBinary) => {
    if (isBinary) {
      handlePacket(client, message);
      return;
    }

    handleTextMessage(client, message);
  });

  ws.on("close", () => {
    cleanupClient(client);
  });

  ws.on("error", () => {
    cleanupClient(client);
  });
});

setInterval(() => {
  const dt = 1 / TICK_RATE;
  tickCounter += 1;
  expireInvites(Date.now());

  for (const client of clients.values()) {
    if (!client.roomId) {
      updateSoloClient(client, dt);
    }
  }

  updateSoloInteractions(dt);

  for (const room of rooms.values()) {
    updateRoom(room, dt);
  }

  if (tickCounter % SNAPSHOT_EVERY_TICKS === 0) {
    for (const client of clients.values()) {
      sendSnapshot(client);
    }
  }
}, Math.round(1000 / TICK_RATE));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Dragon duel server listening on :${PORT}`);
});
