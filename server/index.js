import "dotenv/config";
import express from "express";
import { createServer } from "http";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { Server } from "socket.io";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { fileURLToPath } from "url";

const PORT = Number(process.env.PORT || 4000);
const allowedOrigins = new Set(
  (process.env.CLIENT_ORIGIN || "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);
const hasServerConfig = Boolean(
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
);
const supabaseAdmin = hasServerConfig
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

const MAX_MEDIA_SIZE = 25 * 1024 * 1024;
const ACCEPTED_MEDIA_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm",
]);
const requestBuckets = new Map();

class PublicError extends Error {}

const roomIdSchema = z.object({ roomId: z.string().uuid() });
const createRoomSchema = z.object({ name: z.string().trim().min(2).max(60) });
const inviteSchema = z.object({ inviteCode: z.string().trim().regex(/^[a-f0-9]{36}$/i) });
const attachmentSchema = z.object({
  storagePath: z.string().max(220),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm"]),
  fileName: z.string().trim().min(1).max(120),
  sizeBytes: z.number().int().positive().max(MAX_MEDIA_SIZE),
});
const messageSchema = z.object({
  roomId: z.string().uuid(),
  body: z.string().max(2000).optional().default(""),
  attachments: z.array(attachmentSchema).max(4).optional().default([]),
}).refine((value) => value.body.trim().length > 0 || value.attachments.length > 0);
const typingSchema = z.object({ roomId: z.string().uuid(), isTyping: z.boolean() });
const blockSchema = z.object({ userId: z.string().uuid() });
const reportSchema = z.object({ messageId: z.string().uuid(), reason: z.string().trim().min(10).max(500) });

function corsOrigin(origin, callback) {
  if (!origin || allowedOrigins.has(origin)) return callback(null, true);
  return callback(new Error("Origin is not allowed"));
}

function cleanText(value) {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function publicMessage(error) {
  if (error instanceof PublicError) return error.message;
  if (error instanceof z.ZodError) return "Check the form and try again.";
  console.error("Secure chat operation failed:", error.message);
  return "That action could not be completed. Please try again.";
}

function ensureRate(socket, event, limit, windowMs) {
  const now = Date.now();
  const key = socket.id + ":" + event;
  const bucket = requestBuckets.get(key);
  if (!bucket || now - bucket.startedAt > windowMs) {
    requestBuckets.set(key, { startedAt: now, count: 1 });
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) throw new PublicError("Please slow down and try again shortly.");
}

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw new PublicError("Check the form and try again.");
  return result.data;
}

function roomFromRelation(row) {
  const room = Array.isArray(row.rooms) ? row.rooms[0] : row.rooms;
  return room ? { id: room.id, name: room.name, createdAt: room.created_at } : null;
}

async function getRoomMembership(userId, roomId) {
  const membership = await supabaseAdmin
    .from("room_members")
    .select("room_id, role")
    .eq("room_id", roomId)
    .eq("user_id", userId)
    .maybeSingle();
  if (membership.error) throw membership.error;
  if (!membership.data) return null;
  const room = await supabaseAdmin
    .from("rooms")
    .select("id, name, created_at")
    .eq("id", roomId)
    .maybeSingle();
  if (room.error) throw room.error;
  return room.data ? { ...room.data, role: membership.data.role } : null;
}

async function requireMembership(socket, roomId) {
  const membership = await getRoomMembership(socket.data.user.id, roomId);
  if (!membership) throw new PublicError("You do not have access to that private room.");
  return membership;
}

async function activeRoomMembers(roomId) {
  const sockets = await io.in(roomId).fetchSockets();
  const seen = new Set();
  return sockets
    .map((roomSocket) => roomSocket.data.user)
    .filter((user) => user && !seen.has(user.id) && seen.add(user.id))
    .map((user) => ({ id: user.id, displayName: user.displayName }));
}

async function emitRoomMembers(roomId) {
  io.to(roomId).emit("room_members", await activeRoomMembers(roomId));
}

async function getBlockedAuthorIds(userId, authorIds) {
  if (!authorIds.length) return new Set();
  const result = await supabaseAdmin
    .from("blocked_users")
    .select("blocked_id")
    .eq("blocker_id", userId)
    .in("blocked_id", authorIds);
  if (result.error) throw result.error;
  return new Set(result.data.map((row) => row.blocked_id));
}

async function messageWithAuthors(row) {
  const profiles = await supabaseAdmin
    .from("profiles")
    .select("id, display_name")
    .eq("id", row.author_id)
    .maybeSingle();
  if (profiles.error) throw profiles.error;
  return {
    id: row.id,
    roomId: row.room_id,
    body: row.body,
    createdAt: row.created_at,
    author: {
      id: row.author_id,
      displayName: profiles.data?.display_name || "Member",
    },
    attachments: (row.message_attachments || []).map((attachment) => ({
      id: attachment.id,
      storagePath: attachment.storage_path,
      mimeType: attachment.mime_type,
      fileName: attachment.file_name,
      sizeBytes: attachment.byte_size,
    })),
  };
}

async function getHistory(userId, roomId) {
  const result = await supabaseAdmin
    .from("messages")
    .select("id, room_id, author_id, body, created_at, message_attachments(id, storage_path, mime_type, file_name, byte_size)")
    .eq("room_id", roomId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (result.error) throw result.error;
  const blocked = await getBlockedAuthorIds(userId, result.data.map((message) => message.author_id));
  const visible = result.data.filter((message) => !blocked.has(message.author_id)).reverse();
  return Promise.all(visible.map(messageWithAuthors));
}

function validStorageName(userId, storagePath) {
  const prefix = userId + "/";
  if (!storagePath.startsWith(prefix)) return false;
  const filename = storagePath.slice(prefix.length);
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,180}$/.test(filename);
}

async function verifyAttachment(userId, attachment) {
  if (!validStorageName(userId, attachment.storagePath)) {
    throw new PublicError("An attachment did not pass the safety check.");
  }
  const filename = attachment.storagePath.slice(userId.length + 1);
  const result = await supabaseAdmin.storage.from("chat-media").list(userId, {
    limit: 100,
    search: filename,
  });
  if (result.error) throw result.error;
  const object = result.data.find((entry) => entry.name === filename);
  const mimetype = object?.metadata?.mimetype;
  const size = Number(object?.metadata?.size);
  if (!object || !ACCEPTED_MEDIA_TYPES.has(mimetype) || mimetype !== attachment.mimeType || size !== attachment.sizeBytes || size > MAX_MEDIA_SIZE) {
    throw new PublicError("An attachment did not pass the safety check.");
  }
}

async function emitMessageToAllowed(roomId, message) {
  const roomSockets = await io.in(roomId).fetchSockets();
  const recipientIds = [...new Set(roomSockets.map((roomSocket) => roomSocket.data.user?.id).filter(Boolean))];
  const result = recipientIds.length
    ? await supabaseAdmin.from("blocked_users").select("blocker_id").eq("blocked_id", message.author.id).in("blocker_id", recipientIds)
    : { data: [] };
  if (result.error) throw result.error;
  const blockedRecipients = new Set(result.data.map((row) => row.blocker_id));
  roomSockets.forEach((roomSocket) => {
    if (!blockedRecipients.has(roomSocket.data.user?.id) || roomSocket.data.user?.id === message.author.id) {
      roomSocket.emit("receive_message", message);
    }
  });
}

async function enterRoom(socket, room, inviteCode = "") {
  if (socket.data.roomId && socket.data.roomId !== room.id) socket.leave(socket.data.roomId);
  socket.join(room.id);
  socket.data.roomId = room.id;
  socket.emit("room_joined", {
    id: room.id,
    name: room.name,
    createdAt: room.created_at,
    inviteCode,
  });
  socket.emit("message_history", await getHistory(socket.data.user.id, room.id));
  await emitRoomMembers(room.id);
  if (socket.data.previousRoomId && socket.data.previousRoomId !== room.id) {
    await emitRoomMembers(socket.data.previousRoomId);
  }
}

async function listRooms(socket) {
  const result = await supabaseAdmin
    .from("room_members")
    .select("role, rooms!inner(id, name, created_at)")
    .eq("user_id", socket.data.user.id)
    .order("created_at", { foreignTable: "rooms", ascending: false });
  if (result.error) throw result.error;
  socket.emit("room_list", result.data.map(roomFromRelation).filter(Boolean));
}

function guarded(socket, event, action) {
  socket.on(event, async (payload, ack) => {
    try {
      const result = await action(payload);
      if (typeof ack === "function") ack({ ok: true, ...result });
    } catch (error) {
      const message = publicMessage(error);
      socket.emit("app_error", { message });
      if (typeof ack === "function") ack({ ok: false, message });
    }
  });
}

const app = express();
app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: corsOrigin, methods: ["GET", "POST"] }));
app.use(express.json({ limit: "12kb" }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false }));
app.get("/health", (_request, response) => response.status(hasServerConfig ? 200 : 503).json({
  ok: hasServerConfig,
  message: hasServerConfig ? "Secure chat server is ready." : "Server auth is not configured.",
}));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: [...allowedOrigins], methods: ["GET", "POST"] },
  allowRequest: (request, callback) => {
    const origin = request.headers.origin;
    callback(null, !origin || allowedOrigins.has(origin));
  },
});

io.use(async (socket, next) => {
  if (!hasServerConfig) return next(new Error("Secure server configuration is missing."));
  const token = socket.handshake.auth?.token;
  if (typeof token !== "string" || token.length < 20) return next(new Error("Authentication is required."));
  try {
    const auth = await supabaseAdmin.auth.getUser(token);
    if (auth.error || !auth.data.user) return next(new Error("Authentication is required."));
    const profile = await supabaseAdmin
      .from("profiles")
      .select("display_name")
      .eq("id", auth.data.user.id)
      .maybeSingle();
    if (profile.error) throw profile.error;
    socket.data.user = {
      id: auth.data.user.id,
      displayName: profile.data?.display_name || cleanText(auth.data.user.email?.split("@")[0] || "Member").slice(0, 40),
    };
    next();
  } catch (error) {
    console.error("Socket authentication failed:", error.message);
    next(new Error("Authentication is required."));
  }
});

io.on("connection", (socket) => {
  socket.on("list_rooms", async () => {
    try {
      await listRooms(socket);
    } catch (error) {
      socket.emit("app_error", { message: publicMessage(error) });
    }
  });

  guarded(socket, "create_room", async (payload) => {
    ensureRate(socket, "create_room", 8, 60 * 60 * 1000);
    const data = parse(createRoomSchema, payload);
    const name = cleanText(data.name);
    if (name.length < 2) throw new PublicError("Give your room a short name.");
    const result = await supabaseAdmin
      .from("rooms")
      .insert({ name, created_by: socket.data.user.id })
      .select("id, name, created_at, invite_code")
      .single();
    if (result.error) throw result.error;
    socket.data.previousRoomId = socket.data.roomId;
    await enterRoom(socket, result.data, result.data.invite_code);
    await listRooms(socket);
    return { room: { id: result.data.id, name: result.data.name } };
  });

  guarded(socket, "join_by_invite", async (payload) => {
    ensureRate(socket, "join_by_invite", 8, 10 * 60 * 1000);
    const data = parse(inviteSchema, payload);
    const result = await supabaseAdmin
      .from("rooms")
      .select("id, name, created_at")
      .eq("invite_code", data.inviteCode.toLowerCase())
      .gt("invite_expires_at", new Date().toISOString())
      .maybeSingle();
    if (result.error) throw result.error;
    if (!result.data) throw new PublicError("That private invite is invalid or has expired.");
    const membership = await supabaseAdmin
      .from("room_members")
      .upsert({ room_id: result.data.id, user_id: socket.data.user.id, role: "member" }, { onConflict: "room_id,user_id", ignoreDuplicates: true });
    if (membership.error) throw membership.error;
    socket.data.previousRoomId = socket.data.roomId;
    await enterRoom(socket, result.data);
    await listRooms(socket);
    return { room: { id: result.data.id, name: result.data.name } };
  });

  guarded(socket, "join_room", async (payload) => {
    const data = parse(roomIdSchema, payload);
    const room = await requireMembership(socket, data.roomId);
    socket.data.previousRoomId = socket.data.roomId;
    await enterRoom(socket, room);
    return { room: { id: room.id, name: room.name } };
  });

  guarded(socket, "send_message", async (payload) => {
    ensureRate(socket, "send_message", 8, 10 * 1000);
    const data = parse(messageSchema, payload);
    if (socket.data.roomId !== data.roomId) throw new PublicError("Open the room before sending a message.");
    await requireMembership(socket, data.roomId);
    const body = data.body.replace(/\u0000/g, "").trim();
    await Promise.all(data.attachments.map((attachment) => verifyAttachment(socket.data.user.id, attachment)));
    const created = await supabaseAdmin
      .from("messages")
      .insert({ room_id: data.roomId, author_id: socket.data.user.id, body })
      .select("id, room_id, author_id, body, created_at")
      .single();
    if (created.error) throw created.error;
    let attachmentRows = [];
    if (data.attachments.length) {
      const inserted = await supabaseAdmin
        .from("message_attachments")
        .insert(data.attachments.map((attachment) => ({
          message_id: created.data.id,
          storage_path: attachment.storagePath,
          mime_type: attachment.mimeType,
          file_name: cleanText(attachment.fileName),
          byte_size: attachment.sizeBytes,
        })))
        .select("id, storage_path, mime_type, file_name, byte_size");
      if (inserted.error) {
        await supabaseAdmin.from("messages").delete().eq("id", created.data.id);
        throw inserted.error;
      }
      attachmentRows = inserted.data;
    }
    const message = await messageWithAuthors({ ...created.data, message_attachments: attachmentRows });
    await emitMessageToAllowed(data.roomId, message);
    return { messageId: message.id };
  });

  socket.on("typing", async (payload) => {
    try {
      ensureRate(socket, "typing", 5, 2 * 1000);
      const data = parse(typingSchema, payload);
      if (socket.data.roomId !== data.roomId) return;
      await requireMembership(socket, data.roomId);
      socket.to(data.roomId).emit("user_typing", {
        displayName: socket.data.user.displayName,
        isTyping: data.isTyping,
      });
    } catch {
      // Typing is intentionally best-effort and never reports internals.
    }
  });

  guarded(socket, "block_user", async (payload) => {
    ensureRate(socket, "block_user", 20, 60 * 60 * 1000);
    const data = parse(blockSchema, payload);
    if (data.userId === socket.data.user.id) throw new PublicError("You cannot block yourself.");
    const result = await supabaseAdmin
      .from("blocked_users")
      .upsert({ blocker_id: socket.data.user.id, blocked_id: data.userId }, { onConflict: "blocker_id,blocked_id" });
    if (result.error) throw result.error;
    return {};
  });

  guarded(socket, "report_message", async (payload) => {
    ensureRate(socket, "report_message", 12, 60 * 60 * 1000);
    const data = parse(reportSchema, payload);
    const message = await supabaseAdmin
      .from("messages")
      .select("id, room_id")
      .eq("id", data.messageId)
      .maybeSingle();
    if (message.error) throw message.error;
    if (!message.data) throw new PublicError("That message is no longer available.");
    await requireMembership(socket, message.data.room_id);
    const result = await supabaseAdmin
      .from("reports")
      .insert({ reporter_id: socket.data.user.id, message_id: data.messageId, reason: cleanText(data.reason) });
    if (result.error) throw result.error;
    return {};
  });

  socket.on("disconnect", async () => {
    requestBuckets.delete(socket.id + ":create_room");
    requestBuckets.delete(socket.id + ":join_by_invite");
    requestBuckets.delete(socket.id + ":send_message");
    requestBuckets.delete(socket.id + ":typing");
    if (socket.data.roomId) {
      try { await emitRoomMembers(socket.data.roomId); } catch { /* best effort */ }
    }
  });
});

// Vercel imports this server through api/index.js. Local development runs this
// file directly, so the listener is created only in that case.
const launchedDirectly = process.argv[1]
  && fileURLToPath(import.meta.url) === process.argv[1];

if (launchedDirectly) {
  httpServer.listen(PORT, () => {
    console.log("Secure chat server listening on port " + PORT);
    if (!hasServerConfig) console.warn("Supabase server configuration is missing; all socket connections will be rejected.");
  });
}

export { app, httpServer };
export default httpServer;
