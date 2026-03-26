const canvas = document.getElementById("arenaCanvas");
const ctx = canvas.getContext("2d");
const APP_CONFIG = window.__APP_CONFIG__ || {};

const startMenu = document.getElementById("startMenu");
const startButton = document.getElementById("startButton");
const nameInput = document.getElementById("nameInput");
const resetButton = document.getElementById("resetButton");
const inviteButton = document.getElementById("inviteButton");
const connectingBanner = document.getElementById("connecting");
const connectionText = document.getElementById("connectionText");
const statusMessage = document.getElementById("statusMessage");
const playerHealthFill = document.getElementById("playerHealthFill");
const playerHealthText = document.getElementById("playerHealthText");
const waterFill = document.getElementById("waterFill");
const waterText = document.getElementById("waterText");
const opponentHealthFill = document.getElementById("opponentHealthFill");
const opponentHealthText = document.getElementById("opponentHealthText");
const roundText = document.getElementById("roundText");
const bitesText = document.getElementById("bitesText");
const pingText = document.getElementById("pingText");
const invitePanel = document.getElementById("invitePanel");
const invitePanelText = document.getElementById("invitePanelText");
const acceptInviteButton = document.getElementById("acceptInviteButton");
const declineInviteButton = document.getElementById("declineInviteButton");

const dragonSprite = new Image();
dragonSprite.src = "dragon.png";
canvas.tabIndex = 0;

const GRID_SIZE = 30;
const WORLD_WIDTH = 7200;
const WORLD_HEIGHT = 5200;
const ARENA = { x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2, radius: 336 };
const PLAYER_RADIUS = 46;
const PLAYER_SPEED = 150;
const BOOST_MULTIPLIER = 1.45;
const BOOST_BURST_MS = 50;
const BOOST_COOLDOWN_MS = 3000;
const BOOST_IMPULSE = 70;
const BOOST_STEP_DISTANCE = 4;
const BOOST_WATER_COST = 14;
const POSITION_LERP_SECONDS = 0.175;
const POINTER_FORCE_RADIUS = 240;
const NORMAL_FORCE = 575;
const BOOST_FORCE = 620;
const NORMAL_FRICTION = 4.15;
const BOOST_FRICTION = 3.4;
const TURN_SPEED = 4.125;
const POINTER_DEADZONE = 22;
const POINTER_STOP_SPEED = 18;
const WATER_BITE_REWARD = 10;
const BITE_RANGE = 122;
const BITE_DAMAGE = 10;
const BITE_COOLDOWN_MS = 2500;
const BITE_COOLDOWN_SECONDS = BITE_COOLDOWN_MS / 1000;
const HEALTH_BAR_TIMEOUT_MS = 1800;
const BITE_BAR_TIMEOUT_MS = 500;
const PING_INTERVAL_MS = 2000;
const SPRITE_ROTATION = -Math.PI / 2;
const PACKET_POINTER = 0x05;
const PACKET_RESIZE = 0x11;
const PACKET_SECONDARY = 0x14;
const PACKET_BOOST = 0x15;
const PACKET_INVITE_1V1 = 0x34;

const state = {
  phase: "menu",
  lastFrame: 0,
  pixelRatio: 1,
  profile: {
    name: "Dragon"
  },
  viewport: { width: window.innerWidth, height: window.innerHeight },
  pointer: {
    screenX: 0,
    screenY: 0,
    worldX: ARENA.x,
    worldY: ARENA.y,
    hasPointer: false,
    mouseDown: false,
    insideCanvas: false
  },
  input: {
    boost: false,
    secondary: false
  },
  camera: {
    x: ARENA.x,
    y: ARENA.y,
    zoom: 1.38,
    targetZoom: 1.38,
    userZoom: 1
  },
  arenaRadius: ARENA.radius,
  currentArena: null,
  player: null,
  opponent: null,
  others: [],
  visibleArenas: [],
  round: {
    wins: 0,
    losses: 0,
    bites: 0,
    opponentBites: 0
  },
  network: {
    socket: null,
    url: "",
    desiredUrl: "",
    connected: false,
    remoteAuthority: false,
    phase: "practice",
    reconnectTimer: null,
    incomingInvite: false,
    outgoingInvite: false,
    pingMs: null,
    lastTargetX: NaN,
    lastTargetY: NaN,
    inviteMode: false,
    inviteHoverId: null,
    incomingInviteName: "",
    outgoingInviteName: ""
  }
};

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

function createDragon(seed = {}) {
  const x = Number.isFinite(seed.x) ? seed.x : ARENA.x - ARENA.radius * 0.42;
  const y = Number.isFinite(seed.y) ? seed.y : ARENA.y;
  const angle = Number.isFinite(seed.angle) ? seed.angle : 0;
  const radius = Number.isFinite(seed.radius) ? seed.radius : PLAYER_RADIUS;
  const health = Number.isFinite(seed.health) ? seed.health : 100;
  const maxHealth = Number.isFinite(seed.maxHealth) ? seed.maxHealth : 100;
  const water = Number.isFinite(seed.water) ? seed.water : 100;
  const maxWater = Number.isFinite(seed.maxWater) ? seed.maxWater : 100;
  const biteCooldown = Number.isFinite(seed.biteCooldown) ? seed.biteCooldown : 0;
  const biteCooldownMax = Number.isFinite(seed.biteCooldownMax) ? seed.biteCooldownMax : BITE_COOLDOWN_SECONDS;

  return {
    remoteId: seed.remoteId || null,
    name: seed.name || "Dragon",
    x,
    y,
    vx: Number.isFinite(seed.vx) ? seed.vx : 0,
    vy: Number.isFinite(seed.vy) ? seed.vy : 0,
    angle,
    radius,
    health,
    maxHealth,
    water,
    maxWater,
    baseSpeed: Number.isFinite(seed.baseSpeed) ? seed.baseSpeed : PLAYER_SPEED,
    boosting: false,
    boostActiveUntil: Number.isFinite(seed.boostActiveUntil) ? seed.boostActiveUntil : 0,
    boostCooldownUntil: Number.isFinite(seed.boostCooldownUntil) ? seed.boostCooldownUntil : 0,
    boostVisual: Number.isFinite(seed.boostVisual) ? seed.boostVisual : 0,
    healVisual: Number.isFinite(seed.healVisual) ? seed.healVisual : 0,
    hurtVisual: 0,
    biteCooldown,
    biteCooldownMax,
    hpBarA: 0,
    hpPer: clamp(maxHealth > 0 ? health / maxHealth : 1, 0, 1),
    hpPerTarget: clamp(maxHealth > 0 ? health / maxHealth : 1, 0, 1),
    hpBarTimeoutAt: 0,
    biteBarA: 0,
    bitePer: clamp(biteCooldownMax > 0 ? biteCooldown / biteCooldownMax : 0, 0, 1),
    bitePerTarget: clamp(biteCooldownMax > 0 ? biteCooldown / biteCooldownMax : 0, 0, 1),
    biteBarTimeoutAt: 0,
    forceHealthBar: false,
    canInvite: seed.canInvite !== false,
    inArena: seed.inArena === true,
    tailX: Number.isFinite(seed.tailX) ? seed.tailX : x,
    tailY: Number.isFinite(seed.tailY) ? seed.tailY : y,
    ox: x,
    oy: y,
    nx: x,
    ny: y,
    oAngle: angle,
    nAngle: angle,
    nRadius: radius,
    updateTime: performance.now()
  };
}

function sanitizeName(value) {
  const trimmed = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 18);

  return trimmed || "Dragon";
}

function persistPlayerName() {
  try {
    window.localStorage.setItem("dragon_duel_name", state.profile.name);
  } catch (_error) {
    // Ignore storage failures in private/incognito or locked-down browsers.
  }
}

function applyPlayerName(nextName) {
  state.profile.name = sanitizeName(nextName);

  if (nameInput && nameInput.value !== state.profile.name) {
    nameInput.value = state.profile.name;
  }

  if (state.player) {
    state.player.name = state.profile.name;
  }

  persistPlayerName();
}

function hydratePlayerName() {
  let savedName = "Dragon";

  try {
    savedName = window.localStorage.getItem("dragon_duel_name") || savedName;
  } catch (_error) {
    // Ignore storage failures and keep the default name.
  }

  applyPlayerName(savedName);
}

function canTriggerBoost(dragon, now = performance.now()) {
  return Boolean(
    dragon &&
    dragon.water >= BOOST_WATER_COST &&
    now >= dragon.boostCooldownUntil
  );
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

function activateBoostBurst(dragon, direction, now = performance.now()) {
  dragon.boostActiveUntil = now + BOOST_BURST_MS;
  dragon.boostCooldownUntil = now + BOOST_COOLDOWN_MS;
  dragon.x += direction.x * BOOST_STEP_DISTANCE;
  dragon.y += direction.y * BOOST_STEP_DISTANCE;
  dragon.ox = dragon.x;
  dragon.oy = dragon.y;
  dragon.nx = dragon.x;
  dragon.ny = dragon.y;
  dragon.vx += direction.x * BOOST_IMPULSE;
  dragon.vy += direction.y * BOOST_IMPULSE;
  dragon.water = Math.max(0, dragon.water - BOOST_WATER_COST);
  dragon.boosting = true;
  dragon.boostVisual = Math.max(dragon.boostVisual, 0.72);
}

function healthRatio(dragon) {
  if (!dragon || dragon.maxHealth <= 0) {
    return 1;
  }

  return clamp(dragon.health / dragon.maxHealth, 0, 1);
}

function biteCooldownRatio(dragon) {
  if (!dragon || dragon.biteCooldownMax <= 0) {
    return 0;
  }

  return clamp(dragon.biteCooldown / dragon.biteCooldownMax, 0, 1);
}

function syncDragonStatusBars(dragon, options = {}) {
  if (!dragon) {
    return;
  }

  const now = performance.now();
  const healthChanged = options.healthChanged === true;
  const biteChanged = options.biteChanged === true;
  const healed = options.healed === true;

  dragon.hpPerTarget = healthRatio(dragon);
  dragon.bitePerTarget = biteCooldownRatio(dragon);

  if (healthChanged || healed) {
    dragon.hpBarTimeoutAt = now + HEALTH_BAR_TIMEOUT_MS;
  }

  if (biteChanged || dragon.bitePerTarget > 0.001) {
    dragon.biteBarTimeoutAt = now + BITE_BAR_TIMEOUT_MS;
  }

  if (healed) {
    dragon.healVisual = 1;
  }

  if (healthChanged) {
    dragon.hurtVisual = 1;
  }
}

function updateDragonStatusVisuals(dragon, dt) {
  if (!dragon) {
    return;
  }

  if (dragon.biteCooldown > 0) {
    dragon.biteCooldown = Math.max(0, dragon.biteCooldown - dt);
  }

  syncDragonStatusBars(dragon);

  const now = performance.now();
  const showHealthBar = dragon.forceHealthBar || now < dragon.hpBarTimeoutAt;
  const showBiteBar = dragon.bitePerTarget > 0.001 || now < dragon.biteBarTimeoutAt;

  dragon.hpBarA += ((showHealthBar ? 1 : 0) - dragon.hpBarA) * 0.04;
  dragon.hpPer += (dragon.hpPerTarget - dragon.hpPer) * 0.1;
  dragon.biteBarA += ((showBiteBar ? 1 : 0) - dragon.biteBarA) * 0.04;
  dragon.bitePer += (dragon.bitePerTarget - dragon.bitePer) * 0.1;
  dragon.healVisual = approach(dragon.healVisual, 0, 9, dt);
  dragon.hurtVisual = approach(dragon.hurtVisual, 0, 8, dt);
}

function syncRemoteDragon(current, snapshot, defaults = {}) {
  const mergedSnapshot = { ...defaults, ...snapshot };
  const dragon = current || createDragon(mergedSnapshot);
  const nextX = Number.isFinite(mergedSnapshot.x) ? mergedSnapshot.x : dragon.nx;
  const nextY = Number.isFinite(mergedSnapshot.y) ? mergedSnapshot.y : dragon.ny;
  const nextAngle = Number.isFinite(mergedSnapshot.angle) ? mergedSnapshot.angle : dragon.angle;
  const nextRadius = Number.isFinite(mergedSnapshot.radius) ? mergedSnapshot.radius : dragon.radius;
  const previousHealth = dragon.health;
  const previousBiteCooldown = dragon.biteCooldown;

  setMovedToPos(dragon, nextX, nextY);
  dragon.oAngle = dragon.angle;
  dragon.nAngle = nextAngle;
  dragon.nRadius = nextRadius;

  dragon.vx = Number.isFinite(mergedSnapshot.vx) ? mergedSnapshot.vx : dragon.vx;
  dragon.vy = Number.isFinite(mergedSnapshot.vy) ? mergedSnapshot.vy : dragon.vy;
  dragon.remoteId = typeof mergedSnapshot.id === "string" ? mergedSnapshot.id : dragon.remoteId;
  dragon.name = typeof mergedSnapshot.name === "string" ? sanitizeName(mergedSnapshot.name) : dragon.name;
  dragon.health = Number.isFinite(mergedSnapshot.health) ? mergedSnapshot.health : dragon.health;
  dragon.maxHealth = Number.isFinite(mergedSnapshot.maxHealth) ? mergedSnapshot.maxHealth : dragon.maxHealth;
  dragon.water = Number.isFinite(mergedSnapshot.water) ? mergedSnapshot.water : dragon.water;
  dragon.maxWater = Number.isFinite(mergedSnapshot.maxWater) ? mergedSnapshot.maxWater : dragon.maxWater;
  dragon.baseSpeed = Number.isFinite(mergedSnapshot.baseSpeed) ? mergedSnapshot.baseSpeed : dragon.baseSpeed;
  dragon.biteCooldown = Number.isFinite(mergedSnapshot.biteCooldown) ? mergedSnapshot.biteCooldown : dragon.biteCooldown;
  dragon.biteCooldownMax = Number.isFinite(mergedSnapshot.biteCooldownMax)
    ? mergedSnapshot.biteCooldownMax
    : dragon.biteCooldownMax;
  dragon.boosting = Boolean(mergedSnapshot.boosting);
  dragon.boostVisual = Number.isFinite(mergedSnapshot.boostVisual) ? mergedSnapshot.boostVisual : dragon.boostVisual;
  dragon.healVisual = Number.isFinite(mergedSnapshot.healVisual) ? mergedSnapshot.healVisual : dragon.healVisual;
  dragon.canInvite = mergedSnapshot.canInvite !== false;
  dragon.inArena = mergedSnapshot.inArena === true;
  dragon.tailX = Number.isFinite(mergedSnapshot.tailX) ? mergedSnapshot.tailX : dragon.tailX;
  dragon.tailY = Number.isFinite(mergedSnapshot.tailY) ? mergedSnapshot.tailY : dragon.tailY;
  syncDragonStatusBars(dragon, {
    healthChanged: dragon.health < previousHealth - 0.05,
    healed: dragon.health > previousHealth + 0.05,
    biteChanged: Math.abs(dragon.biteCooldown - previousBiteCooldown) > 0.01
  });

  return dragon;
}

function syncDragonCollection(currentList, snapshots = []) {
  const currentById = new Map();

  for (const dragon of currentList || []) {
    if (dragon && dragon.remoteId) {
      currentById.set(dragon.remoteId, dragon);
    }
  }

  return snapshots
    .filter((snapshot) => snapshot && typeof snapshot === "object")
    .map((snapshot) => syncRemoteDragon(currentById.get(snapshot.id) || null, snapshot));
}

function setMovedToPos(dragon, x, y) {
  dragon.updateTime = performance.now();
  dragon.ox = dragon.x;
  dragon.oy = dragon.y;
  dragon.nx = x;
  dragon.ny = y;
}

function moveUpdate(dragon, dt) {
  if (!dragon) {
    return;
  }

  const progress = clamp((performance.now() - dragon.updateTime) / 1000 / POSITION_LERP_SECONDS, 0, 1);
  const previousX = dragon.x;
  const previousY = dragon.y;

  dragon.x = progress * (dragon.nx - dragon.ox) + dragon.ox;
  dragon.y = progress * (dragon.ny - dragon.oy) + dragon.oy;
  dragon.radius += (dragon.nRadius - dragon.radius) * 0.1;
  dragon.angle += shortestAngleDelta(dragon.angle, dragon.nAngle) * Math.min(0.1 * dt * 60, 1);
  dragon.vx = (dragon.x - previousX) / Math.max(dt, 0.0001);
  dragon.vy = (dragon.y - previousY) / Math.max(dt, 0.0001);

  return Math.min(1, progress);
}

function setStatus(message) {
  statusMessage.textContent = message;
}

function setConnection(message) {
  connectionText.textContent = message;
}

function showConnecting(show) {
  connectingBanner.classList.toggle("hidden", !show);
}

function syncInvitePanel() {
  const showIncoming = state.network.incomingInvite && state.network.phase !== "arena";
  if (invitePanel) {
    invitePanel.classList.toggle("hidden", !showIncoming);
  }
  if (invitePanelText) {
    invitePanelText.textContent = showIncoming
      ? `${state.network.incomingInviteName || "Another dragon"} invited you for 1v1.`
      : "";
  }
}

function setInviteMode(active) {
  const enabled = Boolean(
    active &&
    state.network.connected &&
    state.network.remoteAuthority &&
    state.network.phase !== "arena" &&
    !state.network.incomingInvite
  );

  state.network.inviteMode = enabled;
  if (!enabled) {
    state.network.inviteHoverId = null;
  }
  syncInviteButton();
}

function toggleInviteMode() {
  if (!state.network.connected) {
    setStatus("Live 1v1 invites need the multiplayer server connection.");
    return;
  }

  if (state.network.phase === "arena") {
    setStatus("Finish the arena before sending a new 1v1 invite.");
    return;
  }

  if (state.network.incomingInvite) {
    setStatus("Use Accept or Decline for the incoming 1v1 request.");
    return;
  }

  setInviteMode(!state.network.inviteMode);
  setStatus(state.network.inviteMode ? "Click a dragon to invite it for 1v1." : "Invite targeting cancelled.");
}

function syncInviteButton() {
  const inArena = state.network.remoteAuthority && state.network.phase === "arena";
  const incomingInvite = state.network.incomingInvite;
  const outgoingInvite = state.network.outgoingInvite;
  const offline = !state.network.connected;

  inviteButton.disabled = inArena || offline || outgoingInvite;
  inviteButton.textContent = inArena
    ? "1v1 Live"
    : incomingInvite
      ? "Invite Waiting"
      : state.network.inviteMode
        ? "Cancel Target"
        : outgoingInvite
          ? `Invite: ${state.network.outgoingInviteName || "Sent"}`
          : offline
            ? "1v1 Offline"
            : "Invite for 1v1";
  syncInvitePanel();
}

function sendInviteTarget(targetId) {
  if (!socketIsOpen() || !targetId) {
    return;
  }

  try {
    state.network.socket.send(JSON.stringify({
      type: "invite_player",
      targetId
    }));
  } catch (_error) {
    // Ignore transient send failures. Reconnect will resync snapshots.
  }
}

function sendInviteDecision(type) {
  if (!socketIsOpen()) {
    return;
  }

  try {
    state.network.socket.send(JSON.stringify({ type }));
  } catch (_error) {
    // Ignore transient send failures. Reconnect will resync snapshots.
  }
}

function normalizeServerUrl(url) {
  const trimmedUrl = url.trim();

  if (!trimmedUrl) {
    return "";
  }

  if (trimmedUrl.startsWith("https://")) {
    return `wss://${trimmedUrl.slice("https://".length)}`;
  }

  if (trimmedUrl.startsWith("http://")) {
    return `ws://${trimmedUrl.slice("http://".length)}`;
  }

  return trimmedUrl;
}

function getConfiguredServerUrl() {
  const queryUrl = new URLSearchParams(window.location.search).get("server") || "";
  const configuredUrl = typeof APP_CONFIG.liveServerUrl === "string" ? APP_CONFIG.liveServerUrl : "";
  return normalizeServerUrl(queryUrl || configuredUrl);
}

function clearReconnectTimer() {
  if (state.network.reconnectTimer !== null) {
    window.clearTimeout(state.network.reconnectTimer);
    state.network.reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (!state.network.desiredUrl || state.network.reconnectTimer !== null || socketIsOpen()) {
    return;
  }

  state.network.reconnectTimer = window.setTimeout(() => {
    state.network.reconnectTimer = null;
    connectToServer(state.network.desiredUrl, true);
  }, 2500);
}

function syncHud() {
  const player = state.player;
  const opponent = state.opponent;

  const healthRatio = player ? clamp(player.health / player.maxHealth, 0, 1) : 1;
  const waterRatio = player ? clamp(player.water / player.maxWater, 0, 1) : 1;
  const opponentRatio = opponent ? clamp(opponent.health / opponent.maxHealth, 0, 1) : 0;

  if (playerHealthFill) {
    playerHealthFill.style.transform = `scaleX(${healthRatio})`;
  }
  if (waterFill) {
    waterFill.style.transform = `scaleX(${waterRatio})`;
  }
  if (opponentHealthFill) {
    opponentHealthFill.style.transform = `scaleX(${opponentRatio})`;
  }

  if (playerHealthText) {
    playerHealthText.textContent = player
      ? `${Math.round(player.health)} / ${player.maxHealth}`
      : "100 / 100";
  }

  if (waterText) {
    waterText.textContent = player
      ? `${Math.round(player.water)} / ${player.maxWater}`
      : "100 / 100";
  }

  if (pingText) {
    pingText.textContent = state.network.connected
      ? Number.isFinite(state.network.pingMs)
        ? `Ping ${Math.round(state.network.pingMs)} ms`
        : "Ping ..."
      : state.network.desiredUrl
        ? "Ping --"
        : "Ping -- ms";
  }

  if (opponentHealthText) {
    opponentHealthText.textContent = opponent
      ? `${Math.round(opponent.health)} / ${opponent.maxHealth}`
      : "Waiting";
  }

  if (roundText) {
    roundText.textContent = `Wins ${state.round.wins} - ${state.round.losses}`;
  }
  if (bitesText) {
    bitesText.textContent = `Bites ${state.round.bites} - ${state.round.opponentBites}`;
  }
}

function resizeCanvas() {
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

  state.pixelRatio = pixelRatio;
  state.viewport.width = window.innerWidth;
  state.viewport.height = window.innerHeight;

  canvas.width = Math.round(state.viewport.width * pixelRatio);
  canvas.height = Math.round(state.viewport.height * pixelRatio);
  canvas.style.width = `${state.viewport.width}px`;
  canvas.style.height = `${state.viewport.height}px`;

  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  updatePointerWorld();
  sendResizePacket();
}

function screenToWorld(screenX, screenY) {
  const halfWidth = state.viewport.width / 2;
  const halfHeight = state.viewport.height / 2;

  return {
    x: (screenX - (halfWidth - state.camera.x * state.camera.zoom)) / state.camera.zoom,
    y: (screenY - (halfHeight - state.camera.y * state.camera.zoom)) / state.camera.zoom
  };
}

function worldToScreen(worldX, worldY) {
  return {
    x: worldX * state.camera.zoom + (state.viewport.width / 2 - state.camera.x * state.camera.zoom),
    y: worldY * state.camera.zoom + (state.viewport.height / 2 - state.camera.y * state.camera.zoom)
  };
}

function updatePointerWorld() {
  const world = screenToWorld(state.pointer.screenX, state.pointer.screenY);
  state.pointer.worldX = world.x;
  state.pointer.worldY = world.y;
}

function updatePointerFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  state.pointer.screenX = event.clientX - rect.left;
  state.pointer.screenY = event.clientY - rect.top;
  state.pointer.hasPointer = true;
  state.pointer.insideCanvas = true;
  updatePointerWorld();
}

function distanceToZone(entity, zone) {
  return Math.hypot(entity.x - zone.x, entity.y - zone.y);
}

function clampToWorld(dragon) {
  dragon.x = clamp(dragon.x, dragon.radius, WORLD_WIDTH - dragon.radius);
  dragon.y = clamp(dragon.y, dragon.radius, WORLD_HEIGHT - dragon.radius);
}

function clampToArena(dragon, arena = state.currentArena) {
  if (!arena) {
    clampToWorld(dragon);
    return;
  }

  const dx = dragon.x - arena.x;
  const dy = dragon.y - arena.y;
  const distance = Math.hypot(dx, dy) || 1;
  const limit = arena.radius - dragon.radius - 8;

  if (distance > limit) {
    dragon.x = arena.x + (dx / distance) * limit;
    dragon.y = arena.y + (dy / distance) * limit;
    dragon.vx *= 0.28;
    dragon.vy *= 0.28;
  }

  clampToWorld(dragon);
}

function findInviteTargetAt(worldX, worldY) {
  if (state.network.phase === "arena") {
    return null;
  }

  let bestTarget = null;
  let bestDistance = Infinity;

  for (const dragon of state.others) {
    if (!dragon || dragon.inArena || dragon.canInvite === false || !dragon.remoteId) {
      continue;
    }

    const distance = Math.hypot(worldX - dragon.x, worldY - dragon.y);
    const targetRadius = dragon.radius * 1.24;
    if (distance <= targetRadius && distance < bestDistance) {
      bestTarget = dragon;
      bestDistance = distance;
    }
  }

  return bestTarget;
}

function spawnDragon() {
  state.player = createDragon({
    name: state.profile.name,
    x: ARENA.x,
    y: ARENA.y
  });
  syncDragonStatusBars(state.player, { healed: true });
  state.opponent = null;
  state.others = [];
  state.visibleArenas = [];
  state.currentArena = null;
  state.phase = "running";
  state.network.phase = "practice";
  state.pointer.hasPointer = false;
  state.input.boost = false;
  state.input.secondary = false;
  state.network.lastTargetX = NaN;
  state.network.lastTargetY = NaN;
  state.network.inviteMode = false;
  state.network.inviteHoverId = null;

  state.round.bites = 0;
  state.round.opponentBites = 0;
  state.arenaRadius = ARENA.radius;

  state.camera.x = state.player.x;
  state.camera.y = state.player.y;
  state.camera.zoom = 1.14;
  state.camera.targetZoom = 1.14;

  setStatus("Dragon spawned. Mouse to move, left click or Space to boost, Q to invite for 1v1.");
  syncHud();
  syncInviteButton();
}

function resetArena() {
  if (state.network.connected && state.network.remoteAuthority) {
    setStatus("Live arena resets on the server.");
    return;
  }

  spawnDragon();
  if (state.network.connected) {
    setStatus("Arena reset.");
  }
}

function updateLocalDragon(dt) {
  if (!state.player) {
    return;
  }

  const dragon = state.player;
  const previousX = dragon.x;
  const previousY = dragon.y;
  const targetX = state.pointer.hasPointer
    ? state.pointer.worldX
    : dragon.x + Math.cos(dragon.angle) * 120;
  const targetY = state.pointer.hasPointer
    ? state.pointer.worldY
    : dragon.y + Math.sin(dragon.angle) * 120;

  const direction = normalize(targetX - dragon.x, targetY - dragon.y);
  const distance = direction.length;
  const effectiveDistance = Math.max(0, distance - POINTER_DEADZONE);
  const now = performance.now();
  const wantsBoost = now < dragon.boostActiveUntil && dragon.water > 0.5;
  const maxSpeed = dragon.baseSpeed * (wantsBoost ? BOOST_MULTIPLIER : 1);
  const pointerRatio = clamp(effectiveDistance / Math.max(1, POINTER_FORCE_RADIUS - POINTER_DEADZONE), 0, 1);
  const thrustScale = effectiveDistance > 0.001
    ? Math.min(1, 0.09 + Math.pow(pointerRatio, 1.6) * 1.12)
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

  if (effectiveDistance > 0.001) {
    const targetAngle = Math.atan2(direction.y, direction.x);
    dragon.angle += shortestAngleDelta(dragon.angle, targetAngle) * Math.min(TURN_SPEED * dt, 1);
  }

  if (!wantsBoost) {
    dragon.boostActiveUntil = 0;
  }
  dragon.boosting = wantsBoost && speed > 10;
  dragon.boostVisual = approach(dragon.boostVisual, dragon.boosting ? 1 : 0, 10, dt);
  syncDragonStatusBars(dragon);

  if (state.currentArena) {
    clampToArena(dragon, state.currentArena);
  } else {
    clampToWorld(dragon);
  }
}

function updateCamera(dt) {
  if (!state.player) {
    state.camera.x = approach(state.camera.x, ARENA.x, 3.5, dt);
    state.camera.y = approach(state.camera.y, ARENA.y, 3.5, dt);
    state.camera.zoom = approach(state.camera.zoom, state.camera.targetZoom, 3.5, dt);
    return;
  }

  const zoomScale = state.camera.userZoom;
  state.camera.x = approach(state.camera.x, state.player.x, 7, dt);
  state.camera.y = approach(state.camera.y, state.player.y, 7, dt);
  state.camera.targetZoom = (state.player.boosting ? 1.08 : 1.14) * zoomScale;
  state.camera.zoom = approach(state.camera.zoom, state.camera.targetZoom, 4.4, dt);
}

function beginWorldTransform() {
  const halfWidth = state.viewport.width / 2;
  const halfHeight = state.viewport.height / 2;

  ctx.save();
  ctx.translate(
    halfWidth * (1 - state.camera.zoom) + (halfWidth - state.camera.x) * state.camera.zoom,
    halfHeight * (1 - state.camera.zoom) + (halfHeight - state.camera.y) * state.camera.zoom
  );
  ctx.scale(state.camera.zoom, state.camera.zoom);
}

function drawWorld() {
  ctx.fillStyle = "#3fba54";
  ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

  ctx.strokeStyle = "rgba(17, 66, 17, 0.38)";
  ctx.lineWidth = 12;
  ctx.strokeRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
}

function drawGrid() {
  const topLeft = screenToWorld(0, 0);
  const bottomRight = screenToWorld(state.viewport.width, state.viewport.height);
  const minX = clamp(topLeft.x, 0, WORLD_WIDTH);
  const minY = clamp(topLeft.y, 0, WORLD_HEIGHT);
  const maxX = clamp(bottomRight.x, 0, WORLD_WIDTH);
  const maxY = clamp(bottomRight.y, 0, WORLD_HEIGHT);

  ctx.save();
  ctx.strokeStyle = "black";
  ctx.globalAlpha = 0.055;
  ctx.lineWidth = 1;

  const width = maxX - minX;
  const height = maxY - minY;

  for (let x = -0.5 + minX + (width - minX) % GRID_SIZE; x <= minX + width; x += GRID_SIZE) {
    ctx.beginPath();
    ctx.moveTo(x, minY);
    ctx.lineTo(x, minY + height);
    ctx.stroke();
  }

  for (let y = -0.5 + minY + (height - minY) % GRID_SIZE; y <= minY + height; y += GRID_SIZE) {
    ctx.beginPath();
    ctx.moveTo(minX, y);
    ctx.lineTo(minX + width, y);
    ctx.stroke();
  }

  ctx.restore();
}

function drawArena(arena, label = "") {
  if (!arena) {
    return;
  }

  const arenaGradient = ctx.createRadialGradient(
    arena.x,
    arena.y,
    arena.radius * 0.25,
    arena.x,
    arena.y,
    arena.radius
  );
  arenaGradient.addColorStop(0, "rgba(98, 183, 75, 0.18)");
  arenaGradient.addColorStop(1, "rgba(29, 87, 20, 0.52)");

  ctx.fillStyle = arenaGradient;
  ctx.beginPath();
  ctx.arc(arena.x, arena.y, arena.radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.lineWidth = 10;
  ctx.strokeStyle = "rgba(255, 161, 103, 0.42)";
  ctx.beginPath();
  ctx.arc(arena.x, arena.y, arena.radius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  for (const ring of [0.3, 0.56, 0.82]) {
    ctx.beginPath();
    ctx.arc(arena.x, arena.y, arena.radius * ring, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (label) {
    ctx.save();
    ctx.font = "700 16px Segoe UI";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(241, 255, 251, 0.78)";
    ctx.fillText(label, arena.x, arena.y - arena.radius - 24);
    ctx.restore();
  }
}

function drawZone(zone, innerColor, outerColor, label) {
  const gradient = ctx.createRadialGradient(zone.x, zone.y, zone.radius * 0.22, zone.x, zone.y, zone.radius);
  gradient.addColorStop(0, innerColor);
  gradient.addColorStop(1, outerColor);

  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
  ctx.beginPath();
  ctx.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = "rgba(255, 255, 255, 0.58)";
  ctx.font = "700 20px Segoe UI";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, zone.x, zone.y);
}

function drawDragonName(dragon) {
  if (!dragon || !dragon.name) {
    return;
  }

  const scale = Math.max(1, dragon.radius / 25);
  const y = dragon.y - dragon.radius - 24 * scale;

  ctx.save();
  ctx.font = `${Math.round(12 * scale)}px Segoe UI`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(241, 255, 251, 0.9)";
  ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
  ctx.shadowBlur = 10;
  ctx.fillText(dragon.name, dragon.x, y);
  ctx.restore();
}

function drawDragonBar(dragon, color, alpha, ratio, heightScale, yOffsetScale) {
  const scale = Math.max(1, dragon.radius / 25);
  const width = 20 * scale;
  const height = heightScale * scale;
  const y = -dragon.radius - yOffsetScale * scale;

  ctx.save();
  ctx.translate(dragon.x, dragon.y);
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
  ctx.fillRect(-width / 2, y - height / 2, width, height);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fillRect(-width / 2, y - height / 2, width * clamp(ratio, 0, 1), height);
  ctx.restore();
}

function drawDragonBars(dragon) {
  if (!dragon) {
    return;
  }

  drawDragonName(dragon);

  if (dragon.hpBarA > 0.001) {
    drawDragonBar(dragon, "#16D729", dragon.hpBarA, dragon.hpPer, 5, 10);
  }

  if (dragon.biteBarA > 0.001 && dragon.bitePer > 0.001) {
    drawDragonBar(dragon, "#F3C553", dragon.biteBarA, dragon.bitePer, 2, 6.5);
  }
}

function drawDragon(dragon, glowColor, bodyAlpha = 1) {
  if (!dragon) {
    return;
  }

  const size = dragon.radius * 2.65;

  ctx.save();
  ctx.translate(dragon.x, dragon.y);
  ctx.rotate(dragon.angle + SPRITE_ROTATION);

  ctx.globalAlpha = bodyAlpha;
  ctx.shadowColor = glowColor;
  ctx.shadowBlur = 16;

  if (dragonSprite.complete && dragonSprite.naturalWidth > 0) {
    ctx.drawImage(dragonSprite, -size / 2, -size / 2, size, size);
  } else {
    ctx.fillStyle = "#2ce0ba";
    ctx.beginPath();
    ctx.arc(0, 0, dragon.radius, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
  drawDragonBars(dragon);
}

function drawInviteTargetMarker() {
  if (!state.network.inviteMode) {
    return;
  }

  const target = state.others.find((dragon) => dragon.remoteId === state.network.inviteHoverId);
  if (!target) {
    return;
  }

  ctx.save();
  ctx.strokeStyle = "rgba(255, 248, 112, 0.86)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(target.x, target.y, target.radius + 10, 0, Math.PI * 2);
  ctx.stroke();
  ctx.font = "700 14px Segoe UI";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(255, 248, 112, 0.96)";
  ctx.fillText("Invite", target.x, target.y - target.radius - 18);
  ctx.restore();
}

function drawPointer() {
  if (!state.pointer.hasPointer || !state.player) {
    return;
  }

  const cursor = worldToScreen(state.pointer.worldX, state.pointer.worldY);

  ctx.save();
  ctx.setTransform(state.pixelRatio, 0, 0, state.pixelRatio, 0, 0);
  ctx.strokeStyle = "rgba(196, 255, 245, 0.5)";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(cursor.x, cursor.y, 12, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cursor.x - 18, cursor.y);
  ctx.lineTo(cursor.x + 18, cursor.y);
  ctx.moveTo(cursor.x, cursor.y - 18);
  ctx.lineTo(cursor.x, cursor.y + 18);
  ctx.stroke();
  ctx.restore();
}

function draw() {
  ctx.setTransform(state.pixelRatio, 0, 0, state.pixelRatio, 0, 0);
  ctx.clearRect(0, 0, state.viewport.width, state.viewport.height);

  beginWorldTransform();
  drawWorld();
  drawGrid();
  if (state.currentArena) {
    drawArena(state.currentArena);
  } else {
    for (const arena of state.visibleArenas) {
      drawArena(arena, arena.label || "");
    }
  }
  for (const dragon of state.others) {
    drawDragon(dragon, dragon.inArena ? "#e49f72" : "#9fe7ff", dragon.inArena ? 0.86 : 0.94);
  }
  drawDragon(state.opponent, "#ff9a6b", 0.9);
  drawDragon(state.player, "#65fff0", 1);
  drawInviteTargetMarker();
  ctx.restore();
}

function update(dt) {
  if (state.phase === "running" && (!state.network.connected || !state.network.remoteAuthority)) {
    updateLocalDragon(dt);
  }

  if (state.network.connected && state.network.remoteAuthority) {
    moveUpdate(state.player, dt);
    moveUpdate(state.opponent, dt);
    for (const dragon of state.others) {
      moveUpdate(dragon, dt);
    }
  }

  const showArenaHealthBars = state.network.phase === "arena" && state.opponent != null;
  if (state.player) {
    state.player.forceHealthBar = showArenaHealthBars;
    updateDragonStatusVisuals(state.player, dt);
  }
  if (state.opponent) {
    state.opponent.forceHealthBar = showArenaHealthBars;
    updateDragonStatusVisuals(state.opponent, dt);
  }
  for (const dragon of state.others) {
    dragon.forceHealthBar = false;
    updateDragonStatusVisuals(dragon, dt);
  }

  if (state.network.inviteMode && state.pointer.hasPointer) {
    const inviteTarget = findInviteTargetAt(state.pointer.worldX, state.pointer.worldY);
    state.network.inviteHoverId = inviteTarget ? inviteTarget.remoteId : null;
  } else {
    state.network.inviteHoverId = null;
  }

  updateCamera(dt);
  syncHud();
}

function frame(now) {
  if (!state.lastFrame) {
    state.lastFrame = now;
  }

  const dt = clamp((now - state.lastFrame) / 1000, 0, 0.05);
  state.lastFrame = now;

  update(dt);
  draw();
  requestAnimationFrame(frame);
}

function socketIsOpen() {
  return state.network.socket && state.network.socket.readyState === WebSocket.OPEN;
}

function sendPacket(byteLength, writer) {
  if (!socketIsOpen()) {
    return;
  }

  const view = new DataView(new ArrayBuffer(byteLength));
  writer(view);
  state.network.socket.send(view.buffer);
}

function sendBooleanPacket(code, value) {
  sendPacket(2, (view) => {
    view.setUint8(0, code);
    view.setUint8(1, value ? 1 : 0);
  });
}

function sendResizePacket() {
  sendPacket(7, (view) => {
    view.setUint8(0, PACKET_RESIZE);
    view.setUint16(1, Math.round(state.viewport.width), false);
    view.setUint16(3, Math.round(state.viewport.height), false);
    view.setUint16(5, Math.round(window.innerWidth), false);
  });
}

function sendPointerPacket() {
  if (!socketIsOpen() || state.phase !== "running" || !state.pointer.hasPointer) {
    return;
  }

  if (
    Number.isFinite(state.network.lastTargetX) &&
    Math.abs(state.network.lastTargetX - state.pointer.worldX) <= 0.1 &&
    Math.abs(state.network.lastTargetY - state.pointer.worldY) <= 0.1
  ) {
    return;
  }

  state.network.lastTargetX = state.pointer.worldX;
  state.network.lastTargetY = state.pointer.worldY;

  sendPacket(5, (view) => {
    view.setUint8(0, PACKET_POINTER);
    view.setInt16(1, Math.round(clamp(state.pointer.worldX, -32768, 32767)), false);
    view.setInt16(3, Math.round(clamp(state.pointer.worldY, -32768, 32767)), false);
  });
}

function sendInvitePacket() {
  if (!socketIsOpen()) {
    setStatus(
      state.network.desiredUrl
        ? "The live server is still waking up. Keep the page open and it will reconnect."
        : "Practice mode is active. Real 1v1 invites need a live WebSocket server."
    );
    return;
  }

  toggleInviteMode();
}

function sendPlayerName() {
  if (!socketIsOpen()) {
    return;
  }

  try {
    state.network.socket.send(JSON.stringify({
      type: "set_name",
      name: state.profile.name
    }));
  } catch (_error) {
    // Ignore transient send failures. A fresh snapshot will resync after
    // reconnect if the socket fully drops.
  }
}

function sendRespawn() {
  if (!socketIsOpen()) {
    return;
  }

  try {
    state.network.socket.send(JSON.stringify({ type: "respawn" }));
  } catch (_error) {
    // Ignore transient send failures. A reconnect or later retry will resync.
  }
}

function sendPing() {
  if (!socketIsOpen()) {
    return;
  }

  try {
    state.network.socket.send(JSON.stringify({
      type: "ping",
      sentAt: Date.now()
    }));
  } catch (_error) {
    // Ignore transient ping send errors. The reconnect flow will handle the
    // socket if it fully drops.
  }
}

function tryInvitePointerSelection() {
  if (!state.network.inviteMode) {
    return false;
  }

  const target = findInviteTargetAt(state.pointer.worldX, state.pointer.worldY);
  if (!target) {
    setStatus("Move the cursor over a dragon, then click to send the 1v1 invite.");
    return true;
  }

  setInviteMode(false);
  state.network.outgoingInvite = true;
  state.network.outgoingInviteName = target.name;
  syncInviteButton();
  setStatus(`1v1 request sent to ${target.name}.`);
  sendInviteTarget(target.remoteId);
  return true;
}

function releaseAllActions() {
  state.input.boost = false;

  if (state.input.secondary) {
    state.input.secondary = false;
    sendBooleanPacket(PACKET_SECONDARY, false);
  }
}

function setBoost(active) {
  if (!active) {
    return;
  }

  const dragon = state.player;
  const now = performance.now();
  if (!canTriggerBoost(dragon, now)) {
    return;
  }

  const targetX = state.pointer.hasPointer
    ? state.pointer.worldX
    : dragon.x + Math.cos(dragon.angle) * 120;
  const targetY = state.pointer.hasPointer
    ? state.pointer.worldY
    : dragon.y + Math.sin(dragon.angle) * 120;
  const direction = directionTowardTarget(dragon.x, dragon.y, targetX, targetY, dragon.angle);

  state.input.boost = false;
  if (dragon) {
    activateBoostBurst(dragon, direction, now);
    if (state.currentArena) {
      clampToArena(dragon, state.currentArena);
    } else {
      clampToWorld(dragon);
    }
  }
  sendPointerPacket();
  sendBooleanPacket(PACKET_BOOST, true);
}

function setSecondary(active) {
  if (state.input.secondary === active) {
    return;
  }

  state.input.secondary = active;
  sendBooleanPacket(PACKET_SECONDARY, active);
}

function connectToServer(url, isReconnect = false) {
  const trimmedUrl = normalizeServerUrl(url);
  state.network.desiredUrl = trimmedUrl;
  clearReconnectTimer();

  if (state.network.socket) {
    state.network.socket.close();
    state.network.socket = null;
  }

  state.network.connected = false;
  state.network.remoteAuthority = false;
  state.network.phase = "practice";
  state.network.incomingInvite = false;
  state.network.outgoingInvite = false;
  state.network.incomingInviteName = "";
  state.network.outgoingInviteName = "";
  state.network.inviteMode = false;
  state.network.inviteHoverId = null;
  state.network.pingMs = null;
  state.arenaRadius = ARENA.radius;
  state.currentArena = null;
  state.visibleArenas = [];
  state.others = [];
  state.network.url = trimmedUrl;

  if (!trimmedUrl) {
    setConnection("Practice only");
    showConnecting(false);
    syncInviteButton();
    return;
  }

  try {
    showConnecting(true);
    setConnection(isReconnect ? "Reconnecting" : "Connecting");
    setStatus(isReconnect ? "Trying the live arena again..." : "Connecting to the live arena...");

    const socket = new WebSocket(trimmedUrl);
    socket.binaryType = "arraybuffer";
    state.network.socket = socket;

    socket.addEventListener("open", () => {
      if (state.network.socket !== socket) {
        return;
      }

      state.network.connected = true;
      setConnection("Connected");
      showConnecting(false);
      sendResizePacket();
      sendPlayerName();
      sendPing();
      syncInviteButton();
      setStatus("Connected. Practice mode live.");
    });

    socket.addEventListener("close", () => {
      if (state.network.socket !== socket) {
        return;
      }

      state.network.socket = null;
      state.network.connected = false;
      state.network.remoteAuthority = false;
      state.network.phase = "practice";
      state.network.incomingInvite = false;
      state.network.outgoingInvite = false;
      state.network.incomingInviteName = "";
      state.network.outgoingInviteName = "";
      state.network.inviteMode = false;
      state.network.inviteHoverId = null;
      state.network.pingMs = null;
      setConnection(trimmedUrl ? "Disconnected" : "Practice only");
      showConnecting(false);
      syncInviteButton();
      if (state.network.desiredUrl) {
        setStatus("Live arena disconnected. Reconnecting...");
        scheduleReconnect();
      }
    });

    socket.addEventListener("error", () => {
      if (state.network.socket !== socket) {
        return;
      }

      state.network.connected = false;
      state.network.remoteAuthority = false;
      state.network.phase = "practice";
      state.network.incomingInvite = false;
      state.network.outgoingInvite = false;
      state.network.incomingInviteName = "";
      state.network.outgoingInviteName = "";
      state.network.inviteMode = false;
      state.network.inviteHoverId = null;
      state.network.pingMs = null;
      setConnection("Connection error");
      showConnecting(false);
      syncInviteButton();
      setStatus("Could not reach the live arena yet. It may still be waking up.");
    });

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }

      try {
        const message = JSON.parse(event.data);
        applyServerMessage(message);
      } catch (_error) {
        // Ignore text frames that are not JSON. The original client primarily
        // speaks binary, and this lightweight practice client only mirrors the
        // outgoing packet flow here.
      }
    });
  } catch (_error) {
    state.network.connected = false;
    state.network.remoteAuthority = false;
    state.network.phase = "practice";
    state.network.incomingInvite = false;
    state.network.outgoingInvite = false;
    state.network.incomingInviteName = "";
    state.network.outgoingInviteName = "";
    state.network.inviteMode = false;
    state.network.inviteHoverId = null;
    state.network.pingMs = null;
    setConnection("Connection error");
    showConnecting(false);
    syncInviteButton();
    setStatus("Could not reach the live arena yet. It may still be waking up.");
    scheduleReconnect();
  }
}

function applyServerMessage(message) {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "pong") {
    if (Number.isFinite(message.sentAt)) {
      state.network.pingMs = Math.max(0, Date.now() - message.sentAt);
    }
    return;
  }

  if (typeof message.status === "string") {
    setStatus(message.status);
  }

  if (typeof message.phase === "string") {
    state.network.phase = message.phase;
  }

  state.currentArena = message.arena && typeof message.arena === "object"
    ? {
        id: message.arena.id || null,
        x: Number.isFinite(message.arena.x) ? message.arena.x : ARENA.x,
        y: Number.isFinite(message.arena.y) ? message.arena.y : ARENA.y,
        radius: Number.isFinite(message.arena.radius) ? message.arena.radius : ARENA.radius
      }
    : null;

  if (Number.isFinite(message.arenaRadius)) {
    state.arenaRadius = message.arenaRadius;
  } else if (state.network.phase !== "arena") {
    state.arenaRadius = ARENA.radius;
  }

  state.network.incomingInvite = message.incomingInvite === true;
  state.network.outgoingInvite = message.outgoingInvite === true;
  state.network.incomingInviteName = typeof message.incomingInviteName === "string" ? message.incomingInviteName : "";
  state.network.outgoingInviteName = typeof message.outgoingInviteName === "string" ? message.outgoingInviteName : "";
  if (state.network.phase === "arena") {
    setInviteMode(false);
  }
  syncInviteButton();

  if (message.round && typeof message.round === "object") {
    if (Number.isFinite(message.round.wins)) {
      state.round.wins = message.round.wins;
    }
    if (Number.isFinite(message.round.losses)) {
      state.round.losses = message.round.losses;
    }
    if (Number.isFinite(message.round.bites)) {
      state.round.bites = message.round.bites;
    }
    if (Number.isFinite(message.round.opponentBites)) {
      state.round.opponentBites = message.round.opponentBites;
    }
  }

  if (message.player && typeof message.player === "object") {
    state.network.remoteAuthority = true;
    const previousWater = state.player ? state.player.water : message.player.water;
    state.player = syncRemoteDragon(state.player, message.player);
    if (
      state.player &&
      Number.isFinite(previousWater) &&
      state.player.water > previousWater + WATER_BITE_REWARD * 0.4
    ) {
      state.player.healVisual = Math.max(state.player.healVisual, 1);
    }
  }

  if (message.opponent && typeof message.opponent === "object") {
    state.opponent = syncRemoteDragon(state.opponent, message.opponent, {
      x: state.currentArena ? state.currentArena.x + state.currentArena.radius * 0.42 : ARENA.x + ARENA.radius * 0.42,
      y: state.currentArena ? state.currentArena.y : ARENA.y,
      angle: Math.PI
    });
  } else if (message.opponent === null) {
    state.opponent = null;
  }

  state.others = Array.isArray(message.others)
    ? syncDragonCollection(state.others, message.others)
    : [];
  state.visibleArenas = Array.isArray(message.arenas)
    ? message.arenas
      .filter((arena) => arena && typeof arena === "object")
      .map((arena) => ({
        id: arena.id || null,
        x: Number.isFinite(arena.x) ? arena.x : ARENA.x,
        y: Number.isFinite(arena.y) ? arena.y : ARENA.y,
        radius: Number.isFinite(arena.radius) ? arena.radius : ARENA.radius,
        label: [arena.leftName, arena.rightName].filter(Boolean).join(" vs ")
      }))
    : [];

  if (message.dead === true || (state.network.phase === "practice" && state.player && state.player.health <= 0)) {
    state.phase = "menu";
    startMenu.classList.remove("hidden");
  }
}

function startPractice() {
  if (state.phase === "running" && startMenu.classList.contains("hidden")) {
    return;
  }

  applyPlayerName(nameInput ? nameInput.value : state.profile.name);
  const url = getConfiguredServerUrl();

  if (socketIsOpen() && state.network.connected && state.network.remoteAuthority) {
    state.phase = "running";
    state.arenaRadius = ARENA.radius;
    sendPlayerName();
    sendRespawn();
    startMenu.classList.add("hidden");
    canvas.focus();
    return;
  }

  connectToServer(url);
  spawnDragon();
  if (url) {
    setConnection("Connecting");
    setStatus("Connecting to the live arena...");
  }
  startMenu.classList.add("hidden");
  canvas.focus();
}

function hydrateConnectionState() {
  if (getConfiguredServerUrl()) {
    setConnection("Live ready");
    syncInviteButton();
    return;
  }

  setConnection("Practice only");
  syncInviteButton();
}

window.addEventListener("resize", resizeCanvas);

window.addEventListener("mousemove", (event) => {
  updatePointerFromEvent(event);
});

canvas.addEventListener("mouseenter", (event) => {
  updatePointerFromEvent(event);
});

canvas.addEventListener("mouseleave", () => {
  state.pointer.insideCanvas = false;
  if (!state.pointer.mouseDown) {
    state.pointer.hasPointer = false;
  }
});

canvas.addEventListener("mousedown", (event) => {
  updatePointerFromEvent(event);
  state.pointer.mouseDown = true;

  if (event.button === 0) {
    if (tryInvitePointerSelection()) {
      return;
    }
    setBoost(true);
  } else if (event.button === 2) {
    setSecondary(true);
  }
});

window.addEventListener("mouseup", (event) => {
  state.pointer.mouseDown = false;

  if (event.button === 0) {
    setBoost(false);
  } else if (event.button === 2) {
    setSecondary(false);
  }
});

canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const delta = event.deltaY > 0 ? 0.92 : 1.08;
  state.camera.userZoom = clamp(state.camera.userZoom * delta, 0.78, 1.7);
}, { passive: false });

window.addEventListener("blur", () => {
  state.pointer.mouseDown = false;
  state.pointer.hasPointer = false;
  releaseAllActions();
});

document.addEventListener("keydown", (event) => {
  if (state.phase === "menu" && (event.code === "Enter" || event.code === "NumpadEnter")) {
    event.preventDefault();
    startPractice();
    return;
  }

  if (event.repeat) {
    return;
  }

  switch (event.code) {
    case "Space":
      event.preventDefault();
      setBoost(true);
      break;
    case "KeyW":
      event.preventDefault();
      setSecondary(true);
      break;
    case "KeyQ":
      event.preventDefault();
      sendInvitePacket();
      break;
    default:
      break;
  }
});

document.addEventListener("keyup", (event) => {
  switch (event.code) {
    case "Space":
      event.preventDefault();
      setBoost(false);
      break;
    case "KeyW":
      event.preventDefault();
      setSecondary(false);
      break;
    default:
      break;
  }
});

canvas.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

startButton.addEventListener("click", startPractice);
startButton.addEventListener("pointerup", (event) => {
  event.preventDefault();
  startPractice();
});
if (nameInput) {
  nameInput.addEventListener("change", () => {
    applyPlayerName(nameInput.value);
    sendPlayerName();
  });
}
resetButton.addEventListener("click", resetArena);
inviteButton.addEventListener("click", sendInvitePacket);
acceptInviteButton.addEventListener("click", () => {
  sendInviteDecision("accept_invite");
});
declineInviteButton.addEventListener("click", () => {
  sendInviteDecision("decline_invite");
});

setInterval(sendPointerPacket, 10);
setInterval(sendPing, PING_INTERVAL_MS);

hydratePlayerName();
hydrateConnectionState();
resizeCanvas();
syncHud();
requestAnimationFrame(frame);
