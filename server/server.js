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
const ARENA_SLOTS = [
  { x: WORLD_WIDTH * 0.24, y: WORLD_HEIGHT * 0.3 },
  { x: WORLD_WIDTH * 0.5, y: WORLD_HEIGHT * 0.22 },
  { x: WORLD_WIDTH * 0.76, y: WORLD_HEIGHT * 0.3 },
  { x: WORLD_WIDTH * 0.24, y: WORLD_HEIGHT * 0.7 },
  { x: WORLD_WIDTH * 0.5, y: WORLD_HEIGHT * 0.78 },
  { x: WORLD_WIDTH * 0.76, y: WORLD_HEIGHT * 0.7 }
];
const PLAYER_RADIUS = 46;
const PLAYER_SPEED = 150;
const BOOST_MULTIPLIER = 1.45;
const BOOST_BURST_MS = 50;
const BOOST_COOLDOWN_MS = 3000;
const BOOST_IMPULSE = 70;
const BOOST_STEP_DISTANCE = 4;
const BOOST_WATER_COST = 14;
const POINTER_FORCE_RADIUS = 240;
const NORMAL_FORCE = 575;
const BOOST_FORCE = 620;
const NORMAL_FRICTION = 4.15;
const BOOST_FRICTION = 3.4;
const TURN_SPEED = 4.125;
const POINTER_DEADZONE = 22;
const POINTER_STOP_SPEED = 18;
const WATER_BITE_REWARD = 10;
const PACKET_POINTER = 0x05;
const PACKET_RESIZE = 0x11;
const PACKET_SECONDARY = 0x14;
const PACKET_BOOST = 0x15;
const PACKET_INVITE_1V1 = 0x34;
const BITE_DAMAGE = 10;
const BITE_COOLDOWN = 2.5;
const MOUTH_HITBOX_OFFSET = 1.16;
const MOUTH_HITBOX_HALF_LENGTH = 0.2;
const FRONT_SAFE_HALF_ANGLE = Math.PI / 3;
const TAIL_SECTOR_INNER_FACTOR = 0.72;
const TAIL_SECTOR_OUTER_FACTOR = 1.42;
const ROOM_MIN_ARENA_RADIUS = 180;
const ROOM_SHRINK_DELAY_MS = 8000;
const ROOM_SHRINK_PER_SECOND = 2.2;
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
    x: Number.isFinite(seed.x) ? seed.x : ARENA.x,
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

function randomPracticeSpawn() {
  const angle = Math.random() * Math.PI * 2;
  const distance = 90 + Math.random() * 240;
  return {
    x: clamp(ARENA.x + Math.cos(angle) * distance, PLAYER_RADIUS, WORLD_WIDTH - PLAYER_RADIUS),
    y: clamp(ARENA.y + Math.sin(angle) * distance, PLAYER_RADIUS, WORLD_HEIGHT - PLAYER_RADIUS)
  };
}

function nextArenaSlot() {
  const used = new Set(Array.from(rooms.values(), (room) => room.slotIndex));

  for (let index = 0; index < ARENA_SLOTS.length; index += 1) {
    if (!used.has(index)) {
      return index;
    }
  }

  return rooms.size % ARENA_SLOTS.length;
}

function spawnPracticeDragon(client) {
  const spawn = randomPracticeSpawn();
  client.dragon = createDragon({
    name: client.name,
    x: spawn.x,
    y: spawn.y,
    angle: Math.random() * Math.PI * 2
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

function arenaRoleForClient(client, room) {
  if (!client || !room) {
    return null;
  }

  if (room.players[0] === client) {
    return "player1";
  }

  if (room.players[1] === client) {
    return "player2";
  }

  return null;
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
    x: room.centerX - room.arenaRadius * 0.42,
    y: room.centerY,
    angle: 0
  });
  right.dragon = createDragon({
    name: right.name,
    x: room.centerX + room.arenaRadius * 0.42,
    y: room.centerY,
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

  const slotIndex = nextArenaSlot();
  const slot = ARENA_SLOTS[slotIndex];

  const room = {
    id: crypto.randomUUID(),
    players: [inviter, target],
    state: "running",
    resetAt: 0,
    shrinkStartsAt: Date.now() + ROOM_SHRINK_DELAY_MS,
    arenaRadius: ARENA.radius,
    centerX: slot.x,
    centerY: slot.y,
    slotIndex
  };

  inviter.roomId = room.id;
  target.roomId = room.id;
  inviter.status = "1v1 started. Tail bites are live inside the arena.";
  target.status = "1v1 started. Tail bites are live inside the arena.";
  spawnRoom(room);
  rooms.set(room.id, room);
  sendSnapshot(inviter);
  sendSnapshot(target);
}

function handleTargetedInvite(client, targetId) {
  if (!socketIsOpen(client)) {
    return;
  }

  if (client.roomId) {
    client.status = "You are already inside a live 1v1 arena.";
    sendSnapshot(client);
    return;
  }

  if (!targetId || targetId === client.id) {
    client.status = "Pick another dragon for the 1v1 request.";
    sendSnapshot(client);
    return;
  }

  const target = clients.get(targetId);
  if (!target || !socketIsOpen(target) || !target.dragon || target.dead) {
    client.status = "That dragon is no longer available.";
    sendSnapshot(client);
    return;
  }

  if (target.roomId) {
    client.status = "That dragon is already inside another arena.";
    sendSnapshot(client);
    return;
  }

  if (client.outgoingInviteTo) {
    client.status = "You already sent a 1v1 request.";
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
  client.status = `1v1 request sent to ${target.name}.`;
  target.status = `${client.name} invited you for 1v1.`;
  sendSnapshot(client);
  sendSnapshot(target);
}

function acceptInvite(client) {
  if (!client.incomingInviteFrom) {
    client.status = "No 1v1 request to accept.";
    sendSnapshot(client);
    return;
  }

  const inviter = clients.get(client.incomingInviteFrom);
  if (!inviter || inviter.outgoingInviteTo !== client.id) {
    clearClientInvites(client, "Practice mode live.");
    return;
  }

  startLiveArena(inviter, client);
}

function declineInvite(client) {
  if (!client.incomingInviteFrom) {
    return;
  }

  const inviter = clients.get(client.incomingInviteFrom);
  clearInvitePair(
    inviter,
    client,
    inviter && !inviter.roomId ? `${client.name} declined your 1v1 request.` : null,
    "1v1 request declined."
  );
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

function clampToWorld(dragon) {
  dragon.x = clamp(dragon.x, dragon.radius, WORLD_WIDTH - dragon.radius);
  dragon.y = clamp(dragon.y, dragon.radius, WORLD_HEIGHT - dragon.radius);
}

function clampToArena(dragon, arenaRadius = ARENA.radius, arenaX = ARENA.x, arenaY = ARENA.y) {
  const dx = dragon.x - arenaX;
  const dy = dragon.y - arenaY;
  const distance = Math.hypot(dx, dy) || 1;
  const limit = arenaRadius - dragon.radius - 8;

  if (distance > limit) {
    dragon.x = arenaX + (dx / distance) * limit;
    dragon.y = arenaY + (dy / distance) * limit;
    dragon.vx *= 0.28;
    dragon.vy *= 0.28;
  }

  clampToWorld(dragon);
}

function distanceToZone(entity, zone) {
  return Math.hypot(entity.x - zone.x, entity.y - zone.y);
}

function updateDragon(client, dt, arenaRadius = null, arenaX = ARENA.x, arenaY = ARENA.y) {
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
  const effectiveDistance = Math.max(0, distance - POINTER_DEADZONE);
  const now = Date.now();
  const wantsBoost = now < client.boostActiveUntil && dragon.water > 0.5;
  const maxSpeed = dragon.baseSpeed * (wantsBoost ? BOOST_MULTIPLIER : 1);
  const pointerRatio = clamp(effectiveDistance / Math.max(1, POINTER_FORCE_RADIUS - POINTER_DEADZONE), 0, 1);
  const thrustScale = effectiveDistance > 0.001
    ? Math.min(1, 0.105 + Math.pow(pointerRatio, 1.55) * 1.14)
    : 0;
  const force = (wantsBoost ? BOOST_FORCE : NORMAL_FORCE) * thrustScale;
  const friction = wantsBoost ? BOOST_FRICTION : NORMAL_FRICTION;

  if (effectiveDistance > 0.001) {
    dragon.vx += direction.x * force * dt;
    dragon.vy += direction.y * force * dt;
  }

  dragon.vx *= Math.exp(-friction * dt);
  dragon.vy *= Math.exp(-friction * dt);

  if (effectiveDistance <= 0.001) {
    dragon.vx *= Math.exp(-7.8 * dt);
    dragon.vy *= Math.exp(-7.8 * dt);
    if (Math.hypot(dragon.vx, dragon.vy) < POINTER_STOP_SPEED) {
      dragon.vx = 0;
      dragon.vy = 0;
    }
  }

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

  if (!wantsBoost) {
    client.boostActiveUntil = 0;
  }
  dragon.boosting = wantsBoost && speed > 10;
  dragon.boostVisual = approach(dragon.boostVisual, dragon.boosting ? 1 : 0, 10, dt);
  dragon.healVisual = approach(dragon.healVisual, 0, 9, dt);

  if (arenaRadius != null) {
    clampToArena(dragon, arenaRadius, arenaX, arenaY);
  } else {
    clampToWorld(dragon);
  }
}

function mouthPointForDragon(dragon) {
  return {
    x: dragon.x + Math.cos(dragon.angle) * dragon.radius * MOUTH_HITBOX_OFFSET,
    y: dragon.y + Math.sin(dragon.angle) * dragon.radius * MOUTH_HITBOX_OFFSET
  };
}

function mouthHitboxSegmentForDragon(dragon) {
  const center = mouthPointForDragon(dragon);
  const perpendicularAngle = dragon.angle + Math.PI / 2;
  const halfLength = dragon.radius * MOUTH_HITBOX_HALF_LENGTH;
  const px = Math.cos(perpendicularAngle) * halfLength;
  const py = Math.sin(perpendicularAngle) * halfLength;

  return {
    center,
    x1: center.x - px,
    y1: center.y - py,
    x2: center.x + px,
    y2: center.y + py
  };
}

function pointInTailSector(dragon, pointX, pointY) {
  const dx = pointX - dragon.x;
  const dy = pointY - dragon.y;
  const distance = Math.hypot(dx, dy);
  const minRadius = dragon.radius * TAIL_SECTOR_INNER_FACTOR;
  const maxRadius = dragon.radius * TAIL_SECTOR_OUTER_FACTOR;

  if (distance < minRadius || distance > maxRadius) {
    return false;
  }

  const angleToPoint = Math.atan2(dy, dx);
  const forwardError = Math.abs(shortestAngleDelta(dragon.angle, angleToPoint));
  return forwardError >= FRONT_SAFE_HALF_ANGLE;
}

function tailSectorOuterPointForDragon(dragon) {
  return {
    x: dragon.x - Math.cos(dragon.angle) * dragon.radius * TAIL_SECTOR_OUTER_FACTOR,
    y: dragon.y - Math.sin(dragon.angle) * dragon.radius * TAIL_SECTOR_OUTER_FACTOR
  };
}

function tailSectorInnerPointForDragon(dragon) {
  return {
    x: dragon.x - Math.cos(dragon.angle) * dragon.radius * TAIL_SECTOR_INNER_FACTOR,
    y: dragon.y - Math.sin(dragon.angle) * dragon.radius * TAIL_SECTOR_INNER_FACTOR
  };
}

function touchesArenaBoundary(dragon, arenaRadius, arenaX, arenaY) {
  const distance = Math.hypot(dragon.x - arenaX, dragon.y - arenaY);
  const limit = arenaRadius - dragon.radius - 8;
  return distance >= limit - 6;
}

function applyArenaBurn(client, arenaRadius, arenaX, arenaY, dt) {
  if (!client.dragon || client.dragon.health <= 0) {
    return;
  }

  if (!touchesArenaBoundary(client.dragon, arenaRadius, arenaX, arenaY)) {
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
    attacker.biteCooldown > 0 ||
    !attacker.dragon ||
    !defender.dragon ||
    defender.dragon.health <= 0
  ) {
    return;
  }

  const mouth = mouthPointForDragon(attacker.dragon);

  if (!pointInTailSector(defender.dragon, mouth.x, mouth.y)) {
    return;
  }

  attacker.biteCooldown = BITE_COOLDOWN;
  attacker.roundBites += 1;
  attacker.dragon.water = Math.min(attacker.dragon.maxWater, attacker.dragon.water + WATER_BITE_REWARD);
  attacker.dragon.healVisual = 1;
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
      room.shrinkStartsAt = Date.now() + ROOM_SHRINK_DELAY_MS;
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
  if (Date.now() >= room.shrinkStartsAt) {
    room.arenaRadius = Math.max(ROOM_MIN_ARENA_RADIUS, room.arenaRadius - ROOM_SHRINK_PER_SECOND * dt);
  }
  updateDragon(left, dt, room.arenaRadius, room.centerX, room.centerY);
  updateDragon(right, dt, room.arenaRadius, room.centerX, room.centerY);
  applyArenaBurn(left, room.arenaRadius, room.centerX, room.centerY, dt);
  applyArenaBurn(right, room.arenaRadius, room.centerX, room.centerY, dt);
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
  updateDragon(client, dt, null);
  if (client.incomingInviteFrom) {
    const inviter = clients.get(client.incomingInviteFrom);
    client.status = inviter ? `${inviter.name} invited you for 1v1.` : "Incoming 1v1 request.";
  } else if (client.outgoingInviteTo) {
    const target = clients.get(client.outgoingInviteTo);
    client.status = target ? `Waiting for ${target.name} to accept.` : "Waiting for the other dragon to accept.";
  } else {
    client.status = "Practice mode live.";
  }
}

function serializeDragon(dragon, options = {}) {
  const tailOuter = tailSectorOuterPointForDragon(dragon);
  const tailInner = tailSectorInnerPointForDragon(dragon);
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
    healVisual: round1(dragon.healVisual),
    inArena: options.inArena === true,
    arenaRole: options.arenaRole || null,
    tailX: round1(tailOuter.x),
    tailY: round1(tailOuter.y),
    tailInnerX: round1(tailInner.x),
    tailInnerY: round1(tailInner.y)
  };
}

function serializeVisibleClient(target) {
  const room = target.roomId ? rooms.get(target.roomId) : null;
  return {
    id: target.id,
    inArena: Boolean(target.roomId),
    roomId: target.roomId,
    canInvite: !target.roomId && !target.dead,
    ...serializeDragon(target.dragon, {
      inArena: Boolean(target.roomId),
      arenaRole: arenaRoleForClient(target, room)
    })
  };
}

function serializeArena(room) {
  return {
    id: room.id,
    x: round1(room.centerX),
    y: round1(room.centerY),
    radius: round1(room.arenaRadius),
    state: room.state,
    leftName: room.players[0]?.name || "Dragon",
    rightName: room.players[1]?.name || "Dragon",
    player1Name: room.players[0]?.name || "Player 1",
    player2Name: room.players[1]?.name || "Player 2",
    player1Wins: room.players[0]?.wins || 0,
    player2Wins: room.players[1]?.wins || 0,
    player1Bites: room.players[0]?.roundBites || 0,
    player2Bites: room.players[1]?.roundBites || 0
  };
}

function collectVisibleClientsFor(viewer) {
  const visible = [];

  for (const target of clients.values()) {
    if (
      target === viewer ||
      !socketIsOpen(target) ||
      target.dead ||
      !target.dragon
    ) {
      continue;
    }

    visible.push(serializeVisibleClient(target));
  }

  return visible;
}

function collectVisibleArenasFor(viewer) {
  if (viewer.roomId) {
    return [];
  }

  return Array.from(rooms.values(), (room) => serializeArena(room));
}

function updateSoloInteractions() {
  // Practice mode is now a safe main map. Damage is only live inside 1v1 arenas.
}

function sendSnapshot(client) {
  if (!socketIsOpen(client) || !client.dragon) {
    return;
  }

  const room = client.roomId ? rooms.get(client.roomId) : null;
  const roomOpponent = opponentFor(client);
  const incomingInviteClient = client.incomingInviteFrom ? clients.get(client.incomingInviteFrom) : null;
  const outgoingInviteClient = client.outgoingInviteTo ? clients.get(client.outgoingInviteTo) : null;
  const payload = {
    type: "snapshot",
    status: client.status,
    phase: room ? "arena" : "practice",
    dead: client.dead === true,
    arenaRadius: room ? room.arenaRadius : ARENA.radius,
    arena: room ? serializeArena(room) : null,
    arenas: collectVisibleArenasFor(client),
    incomingInvite: client.incomingInviteFrom != null,
    outgoingInvite: client.outgoingInviteTo != null,
    incomingInviteName: incomingInviteClient ? incomingInviteClient.name : null,
    outgoingInviteName: outgoingInviteClient ? outgoingInviteClient.name : null,
    player: serializeDragon(client.dragon, {
      inArena: Boolean(room),
      arenaRole: arenaRoleForClient(client, room)
    }),
    opponent: roomOpponent && roomOpponent.dragon
      ? serializeDragon(roomOpponent.dragon, {
          inArena: Boolean(room),
          arenaRole: arenaRoleForClient(roomOpponent, room)
        })
      : null,
    others: room ? [] : collectVisibleClientsFor(client),
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
        const room = client.roomId ? rooms.get(client.roomId) : null;
        if (room) {
          clampToArena(client.dragon, room.arenaRadius, room.centerX, room.centerY);
        } else {
          clampToWorld(client.dragon);
        }
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

  if (payload.type === "invite_player") {
    handleTargetedInvite(client, payload.targetId);
    return;
  }

  if (payload.type === "accept_invite") {
    acceptInvite(client);
    return;
  }

  if (payload.type === "decline_invite") {
    declineInvite(client);
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

  updateSoloInteractions();

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
