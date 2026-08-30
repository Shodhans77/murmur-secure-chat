import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import { isSupabaseConfigured, supabase } from "./lib/supabase";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:4000";
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 4;
const ACCEPTED_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm",
]);

function displayNameFor(user) {
  return user?.user_metadata?.display_name || user?.email?.split("@")[0] || "Member";
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function friendlyError(error) {
  const message = error?.message || "";
  if (message.toLowerCase().includes("invalid login")) return "That email or password is not correct.";
  if (message.toLowerCase().includes("password")) return "Use a password with at least 8 characters.";
  return message || "Something went wrong. Please try again.";
}

function CreatureGarden() {
  return (
    <div className="creature-garden" aria-hidden="true">
      <div className="spark spark-one" /><div className="spark spark-two" /><div className="spark spark-three" />
      <div className="creature creature-mint"><span className="eye" /><span className="eye" /><span className="smile" /></div>
      <div className="creature creature-lilac"><span className="eye" /><span className="eye" /><span className="smile" /></div>
      <div className="creature creature-sun"><span className="eye" /><span className="eye" /><span className="smile" /></div>
    </div>
  );
}

function AuthScreen() {
  const [mode, setMode] = useState("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const signUp = mode === "signUp";

  async function submit(event) {
    event.preventDefault();
    setError(""); setNotice("");
    if (signUp && name.trim().length < 2) {
      setError("Choose a display name with at least 2 characters.");
      return;
    }
    setBusy(true);
    try {
      if (signUp) {
        const result = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { display_name: name.trim() } },
        });
        if (result.error) throw result.error;
        if (!result.data.session) setNotice("Check your email to confirm your account, then sign in.");
      } else {
        const result = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (result.error) throw result.error;
      }
    } catch (submitError) {
      setError(friendlyError(submitError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-story">
        <div className="brand-lockup"><div className="brand-mark">M</div><span>murmur</span></div>
        <div className="auth-copy">
          <p className="eyebrow">A quieter place to connect</p>
          <h1>Conversations should feel safe, not exposed.</h1>
          <p>Private rooms, controlled media sharing, and clear safety controls help you stay in charge of your space.</p>
        </div>
        <CreatureGarden />
        <p className="auth-footnote">Made for small, trusted groups. Take care of each other.</p>
      </section>
      <section className="auth-panel" aria-labelledby="auth-heading">
        <div className="auth-card">
          <div className="auth-card-heading">
            <p className="eyebrow">{signUp ? "Start safely" : "Welcome back"}</p>
            <h2 id="auth-heading">{signUp ? "Create your account" : "Sign in to murmur"}</h2>
            <p>{signUp ? "Use an email you can access for account recovery." : "Your rooms are waiting for you."}</p>
          </div>
          <form className="auth-form" onSubmit={submit}>
            {signUp && <label>Display name<input autoComplete="nickname" maxLength="40" placeholder="How friends see you" value={name} onChange={(event) => setName(event.target.value)} required /></label>}
            <label>Email<input autoComplete="email" inputMode="email" placeholder="you@example.com" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
            <label>Password<input autoComplete={signUp ? "new-password" : "current-password"} minLength="8" placeholder="At least 8 characters" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
            {error && <p className="form-alert error" role="alert">{error}</p>}
            {notice && <p className="form-alert success" role="status">{notice}</p>}
            <button className="primary-button" disabled={busy} type="submit">{busy ? "Please wait…" : signUp ? "Create a safe space" : "Sign in"}</button>
          </form>
          <p className="auth-switch">
            {signUp ? "Already have an account?" : "New here?"}{" "}
            <button type="button" onClick={() => { setMode(signUp ? "signIn" : "signUp"); setError(""); setNotice(""); }}>
              {signUp ? "Sign in" : "Create an account"}
            </button>
          </p>
          <p className="privacy-note"><span aria-hidden="true">⌁</span>Your password is handled by Supabase Auth and is never sent through the chat server.</p>
        </div>
      </section>
    </main>
  );
}

function SetupScreen() {
  return (
    <main className="setup-page"><div className="setup-card">
      <div className="brand-lockup"><div className="brand-mark">M</div><span>murmur</span></div>
      <h1>Connect the safe chat backend</h1>
      <p>Add the browser-safe Supabase URL and anon key to <code>client/.env</code>, then restart the Vite app.</p>
      <p className="privacy-note">The server service-role key must stay only in <code>server/.env</code>.</p>
    </div></main>
  );
}

function MediaPreview({ file, onRemove }) {
  const isVideo = file.type.startsWith("video/");
  return (
    <div className="media-preview">
      {isVideo ? <video muted preload="metadata" src={file.localUrl} /> : <img alt="" src={file.localUrl} />}
      <div className="media-preview-info"><span title={file.name}>{file.name}</span><small>{Math.ceil(file.size / 1024)} KB</small></div>
      <button aria-label={"Remove " + file.name} className="icon-button remove-media" onClick={() => onRemove(file.id)} type="button">×</button>
    </div>
  );
}

function MessageItem({ message, currentUserId, onBlock, onReport }) {
  const own = message.author?.id === currentUserId;
  return (
    <article className={"message " + (own ? "message-own" : "")}>
      <div className="message-meta">
        <span className="message-avatar" aria-hidden="true">{message.author?.displayName?.slice(0, 1).toUpperCase() || "?"}</span>
        <strong>{own ? "You" : message.author?.displayName || "Member"}</strong>
        <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
      </div>
      {message.body && <p className="message-body">{message.body}</p>}
      {message.attachments?.length > 0 && <div className="message-media">
        {message.attachments.map((attachment) => attachment.url ? (
          attachment.mimeType.startsWith("video/")
            ? <video controls key={attachment.id} preload="metadata" src={attachment.url} />
            : <img alt={attachment.fileName || "Shared image"} key={attachment.id} src={attachment.url} />
        ) : <div className="media-unavailable" key={attachment.id}>Media unavailable</div>)}
      </div>}
      {!own && <div className="message-actions">
        <button onClick={() => onBlock(message.author?.id)} type="button">Block</button>
        <button onClick={() => onReport(message.id)} type="button">Report</button>
      </div>}
    </article>
  );
}

function ChatApp({ session }) {
  const [socket, setSocket] = useState(null);
  const [connection, setConnection] = useState("Connecting securely…");
  const [rooms, setRooms] = useState([]);
  const [room, setRoom] = useState(null);
  const [members, setMembers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [typingUser, setTypingUser] = useState("");
  const [newRoomName, setNewRoomName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [roomInviteCode, setRoomInviteCode] = useState("");
  const [pendingFiles, setPendingFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);
  const typingTimeout = useRef(null);
  const pendingFilesRef = useRef([]);
  const user = session.user;
  const profile = useMemo(() => ({ id: user.id, displayName: displayNameFor(user) }), [user]);

  useEffect(() => { pendingFilesRef.current = pendingFiles; }, [pendingFiles]);
  useEffect(() => () => {
    pendingFilesRef.current.forEach((file) => URL.revokeObjectURL(file.localUrl));
    clearTimeout(typingTimeout.current);
  }, []);

  async function withSignedUrls(rawMessage) {
    const attachments = await Promise.all((rawMessage.attachments || []).map(async (attachment) => {
      const result = await supabase.storage.from("chat-media").createSignedUrl(attachment.storagePath, 300);
      return { ...attachment, url: result.error ? "" : result.data.signedUrl };
    }));
    return { ...rawMessage, attachments };
  }

  useEffect(() => {
    const liveSocket = io(SERVER_URL, {
      auth: { token: session.access_token },
      transports: ["websocket"],
      timeout: 10_000,
      reconnectionAttempts: 5,
    });
    const receiveMessage = async (rawMessage) => {
      const message = await withSignedUrls(rawMessage);
      setMessages((previous) => [...previous, message]);
    };
    const receiveHistory = async (rawMessages) => {
      const hydrated = await Promise.all(rawMessages.map(withSignedUrls));
      setMessages(hydrated);
    };
    liveSocket.on("connect", () => { setConnection("Secure connection active"); liveSocket.emit("list_rooms"); });
    liveSocket.on("connect_error", () => { setConnection("Secure connection unavailable"); setNotice("The chat server could not verify this session. Try signing in again."); });
    liveSocket.on("room_list", setRooms);
    liveSocket.on("room_joined", (nextRoom) => { setRoom(nextRoom); setRoomInviteCode(nextRoom.inviteCode || ""); setMessages([]); setNotice(""); });
    liveSocket.on("room_members", setMembers);
    liveSocket.on("message_history", receiveHistory);
    liveSocket.on("receive_message", receiveMessage);
    liveSocket.on("user_typing", ({ displayName, isTyping }) => setTypingUser(isTyping ? displayName : ""));
    liveSocket.on("app_error", ({ message }) => setNotice(message));
    liveSocket.on("disconnect", () => setConnection("Reconnecting securely…"));
    setSocket(liveSocket);
    return () => { liveSocket.disconnect(); setSocket(null); };
  }, [session.access_token]);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, typingUser]);

  function emitWithAck(event, payload) {
    return new Promise((resolve, reject) => {
      if (!socket?.connected) return reject(new Error("The secure connection is not ready yet."));
      socket.timeout(12_000).emit(event, payload, (timeoutError, response) => {
        if (timeoutError) reject(new Error("The server did not respond. Please try again."));
        else if (!response?.ok) reject(new Error(response?.message || "That action could not be completed."));
        else resolve(response);
      });
    });
  }

  async function createRoom(event) {
    event.preventDefault();
    if (!newRoomName.trim()) return;
    setBusy(true);
    try { await emitWithAck("create_room", { name: newRoomName.trim() }); setNewRoomName(""); }
    catch (actionError) { setNotice(actionError.message); }
    finally { setBusy(false); }
  }

  async function joinByInvite(event) {
    event.preventDefault();
    if (!inviteCode.trim()) return;
    setBusy(true);
    try { await emitWithAck("join_by_invite", { inviteCode: inviteCode.trim() }); setInviteCode(""); }
    catch (actionError) { setNotice(actionError.message); }
    finally { setBusy(false); }
  }

  function chooseFiles(event) {
    const selected = Array.from(event.target.files || []);
    const remaining = MAX_ATTACHMENTS - pendingFiles.length;
    const accepted = [];
    const problems = [];
    selected.slice(0, remaining).forEach((file) => {
      if (!ACCEPTED_TYPES.has(file.type)) problems.push(file.name + ": choose JPG, PNG, WebP, MP4, or WebM.");
      else if (file.size > MAX_FILE_SIZE) problems.push(file.name + ": files must be 25 MB or smaller.");
      else accepted.push({ id: crypto.randomUUID(), file, name: file.name, type: file.type, size: file.size, localUrl: URL.createObjectURL(file) });
    });
    if (selected.length > remaining) problems.push("You can share up to " + MAX_ATTACHMENTS + " files at once.");
    if (problems.length) setNotice(problems[0]);
    if (accepted.length) setPendingFiles((current) => [...current, ...accepted]);
    event.target.value = "";
  }

  function removeFile(id) {
    setPendingFiles((current) => {
      const removed = current.find((file) => file.id === id);
      if (removed) URL.revokeObjectURL(removed.localUrl);
      return current.filter((file) => file.id !== id);
    });
  }

  async function uploadPendingFiles() {
    const uploadedPaths = [];
    try {
      return await Promise.all(pendingFiles.map(async (item) => {
        const safeName = item.name.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 80);
        const storagePath = user.id + "/" + crypto.randomUUID() + "-" + (safeName || "media");
        const result = await supabase.storage.from("chat-media").upload(storagePath, item.file, {
          cacheControl: "3600", contentType: item.type, upsert: false,
        });
        if (result.error) throw result.error;
        uploadedPaths.push(storagePath);
        return { storagePath, mimeType: item.type, fileName: item.name.slice(0, 120), sizeBytes: item.size };
      }));
    } catch (uploadError) {
      if (uploadedPaths.length) await supabase.storage.from("chat-media").remove(uploadedPaths);
      throw uploadError;
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    const body = input.trim();
    if ((!body && !pendingFiles.length) || !room || busy) return;
    if (body.length > 2000) return setNotice("Messages can be up to 2,000 characters.");
    setBusy(true);
    try {
      const attachments = await uploadPendingFiles();
      await emitWithAck("send_message", { roomId: room.id, body, attachments });
      pendingFiles.forEach((file) => URL.revokeObjectURL(file.localUrl));
      setPendingFiles([]); setInput("");
      socket.emit("typing", { roomId: room.id, isTyping: false });
    } catch (sendError) {
      setNotice(friendlyError(sendError));
    } finally { setBusy(false); }
  }

  function onType(event) {
    setInput(event.target.value);
    if (!socket || !room) return;
    socket.emit("typing", { roomId: room.id, isTyping: true });
    clearTimeout(typingTimeout.current);
    typingTimeout.current = setTimeout(() => socket.emit("typing", { roomId: room.id, isTyping: false }), 1200);
  }

  async function blockUser(userId) {
    if (!userId || !window.confirm("Block this person? Their new messages will be hidden for you.")) return;
    try {
      await emitWithAck("block_user", { userId });
      setMessages((current) => current.filter((message) => message.author?.id !== userId));
      setNotice("This person has been blocked. Their new messages are hidden for you.");
    } catch (actionError) { setNotice(actionError.message); }
  }

  async function reportMessage(messageId) {
    const reason = window.prompt("Tell us briefly why this message needs review (10–500 characters):");
    if (!reason) return;
    try { await emitWithAck("report_message", { messageId, reason }); setNotice("Report received. Thank you for helping keep this space safer."); }
    catch (actionError) { setNotice(actionError.message); }
  }

  async function copyInvite() {
    if (!roomInviteCode) return;
    try { await navigator.clipboard.writeText(roomInviteCode); setNotice("Private invite code copied. Share it only with people you trust."); }
    catch { setNotice("Copy the invite code manually: " + roomInviteCode); }
  }

  return (
    <main className="app-shell">
      <aside className="room-sidebar">
        <div className="sidebar-brand"><div className="brand-mark">M</div><span>murmur</span></div>
        <div className="connection-state"><span className={"connection-dot " + (connection === "Secure connection active" ? "active" : "")} />{connection}</div>
        <section className="room-section" aria-labelledby="your-rooms">
          <div className="section-heading"><h2 id="your-rooms">Your rooms</h2></div>
          <div className="room-list">
            {rooms.length ? rooms.map((savedRoom) => <button className={"room-link " + (room?.id === savedRoom.id ? "selected" : "")} key={savedRoom.id} onClick={() => socket?.emit("join_room", { roomId: savedRoom.id })} type="button"><span>#</span>{savedRoom.name}</button>) : <p className="empty-rooms">No rooms yet. Create one below.</p>}
          </div>
        </section>
        <form className="compact-form" onSubmit={createRoom}>
          <label htmlFor="new-room">Create a private room</label>
          <div><input id="new-room" maxLength="60" placeholder="e.g. study buddies" value={newRoomName} onChange={(event) => setNewRoomName(event.target.value)} /><button aria-label="Create room" disabled={busy} type="submit">+</button></div>
        </form>
        <form className="compact-form" onSubmit={joinByInvite}>
          <label htmlFor="invite-code">Join with an invite code</label>
          <div><input id="invite-code" maxLength="36" placeholder="Paste private code" value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} /><button aria-label="Join room" disabled={busy} type="submit">→</button></div>
        </form>
        <div className="account-footer">
          <span className="message-avatar">{profile.displayName.slice(0, 1).toUpperCase()}</span>
          <div><strong>{profile.displayName}</strong><small>{user.email}</small></div>
          <button aria-label="Sign out" className="icon-button" onClick={() => supabase.auth.signOut()} type="button">↗</button>
        </div>
      </aside>
      <section className="chat-area">
        {room ? <>
          <header className="chat-header">
            <div><p className="eyebrow">Private room</p><h1># {room.name}</h1><p>{members.length} trusted {members.length === 1 ? "member" : "members"} in this room</p></div>
            {roomInviteCode && <button className="share-button" onClick={copyInvite} type="button">Copy private invite</button>}
          </header>
          <div className="safety-banner"><span className="safety-icon" aria-hidden="true">⌁</span><p><strong>Keep it kind and private.</strong> You can block or report any message. Only accepted room members can view shared media.</p></div>
          <div className="messages" aria-live="polite">
            {messages.length === 0 && <div className="empty-chat"><div className="empty-chat-orb">✦</div><h2>It’s quiet in here.</h2><p>Say hello, or share a photo or video with this trusted group.</p></div>}
            {messages.map((message) => <MessageItem currentUserId={profile.id} key={message.id} message={message} onBlock={blockUser} onReport={reportMessage} />)}
            {typingUser && <p className="typing-indicator">{typingUser} is typing…</p>}<div ref={messagesEndRef} />
          </div>
          <form className="composer" onSubmit={sendMessage}>
            {notice && <p className="composer-notice" role="status">{notice}</p>}
            {pendingFiles.length > 0 && <div className="media-preview-list">{pendingFiles.map((file) => <MediaPreview file={file} key={file.id} onRemove={removeFile} />)}</div>}
            <div className="composer-row">
              <input accept="image/jpeg,image/png,image/webp,video/mp4,video/webm" className="visually-hidden" id="media-input" multiple onChange={chooseFiles} ref={fileInputRef} type="file" />
              <button aria-label="Choose photos or videos" className="attach-button" disabled={pendingFiles.length >= MAX_ATTACHMENTS || busy} onClick={() => fileInputRef.current?.click()} type="button">＋</button>
              <textarea aria-label="Message" maxLength="2000" onChange={onType} placeholder="Message your trusted group…" rows="1" value={input} />
              <button className="send-button" disabled={busy || (!input.trim() && !pendingFiles.length)} type="submit">{busy ? "Sending…" : "Send"}</button>
            </div>
            <p className="composer-help">JPG, PNG, WebP, MP4, or WebM · up to 25 MB each · {MAX_ATTACHMENTS} files per message</p>
          </form>
        </> : <section className="room-welcome"><CreatureGarden /><p className="eyebrow">Your safe space starts here</p><h1>Create a room or join with a private invite.</h1><p>Rooms are not public. An authenticated member or a valid invite code is required before anyone can enter.</p></section>}
      </section>
    </main>
  );
}

export default function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  useEffect(() => {
    if (!supabase) return undefined;
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setLoading(false); });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => { setSession(nextSession); setLoading(false); });
    return () => listener.subscription.unsubscribe();
  }, []);
  if (!isSupabaseConfigured) return <SetupScreen />;
  if (loading) return <main className="loading-screen">Loading your safe space…</main>;
  if (!session) return <AuthScreen />;
  return <ChatApp session={session} />;
}

