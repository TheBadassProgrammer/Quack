"use client";
import { useState, useRef, useEffect } from "react";
import { io, Socket } from "socket.io-client";

export default function Home() {
  const [view, setView] = useState<"home" | "login" | "otp" | "chat">("home");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");
  const [domain, setDomain] = useState("");
  const [status, setStatus] = useState("Idle");

  const localVideo = useRef<HTMLVideoElement>(null);
  const remoteVideo = useRef<HTMLVideoElement>(null);
  const pc = useRef<RTCPeerConnection | null>(null);
  const socket = useRef<Socket | null>(null);
  const currentRoom = useRef<string | null>(null);

  // 1. Initialize socket and check for persistent login
  useEffect(() => {
    const savedDomain = localStorage.getItem("quack_domain");
    if (savedDomain) {
      setDomain(savedDomain);
      setView("chat");
    }
    socket.current = io(process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:3001");
    return () => { socket.current?.disconnect(); };
  }, []);

  // 2. Auth Flow: Request OTP
  const handleRequestOtp = (e: React.FormEvent) => {
    e.preventDefault();
    const parts = email.split("@");
    if (parts.length !== 2 || (!parts[1].endsWith(".edu") && !parts[1].endsWith(".ac.in"))) {
      setError("Please use a valid college email (.edu or .ac.in)");
      return;
    }
    setError("");
    socket.current?.emit("request_otp", { email });
    
    socket.current?.once("otp_sent", () => {
      setView("otp");
    });
  };

  // 3. Auth Flow: Verify OTP
  const handleVerifyOtp = (e: React.FormEvent) => {
    e.preventDefault();
    socket.current?.emit("verify_otp", { email, code: otp });

    socket.current?.once("otp_verified", (res: { success: boolean; domain?: string; error?: string }) => {
      if (res.success && res.domain) {
        localStorage.setItem("quack_domain", res.domain);
        setDomain(res.domain);
        setView("chat");
      } else {
        setError(res.error || "Invalid OTP");
      }
    });
  };

  const handleLogout = () => {
    localStorage.removeItem("quack_domain");
    setDomain("");
    setView("home");
    setEmail("");
    setOtp("");
    if (remoteVideo.current) remoteVideo.current.srcObject = null;
    pc.current?.close();
  };

  const handleGlobalChat = () => {
    setDomain("global");
    setView("chat");
  };

  // 4. WebRTC Setup (Only runs when in 'chat' view)
  useEffect(() => {
    if (view !== "chat" || !socket.current) return;

    pc.current = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });

    navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then((stream) => {
      if (localVideo.current) localVideo.current.srcObject = stream;
      stream.getTracks().forEach((track) => pc.current?.addTrack(track, stream));
    }).catch(console.error);

    pc.current.ontrack = (event) => {
      if (remoteVideo.current) remoteVideo.current.srcObject = event.streams[0];
    };

    pc.current.onicecandidate = (event) => {
      if (event.candidate && currentRoom.current) {
        socket.current?.emit("webrtc_signal", { roomId: currentRoom.current, signal: { type: "ice", candidate: event.candidate } });
      }
    };

    socket.current.on("match_found", async ({ roomId, initiate }) => {
      currentRoom.current = roomId;
      setStatus("Connected");
      if (initiate && pc.current) {
        const offer = await pc.current.createOffer();
        await pc.current.setLocalDescription(offer);
        socket.current?.emit("webrtc_signal", { roomId, signal: offer });
      }
    });

    socket.current.on("webrtc_signal", async (signal: any) => {
      if (!pc.current) return;
      if (signal.type === "offer") {
        await pc.current.setRemoteDescription(new RTCSessionDescription(signal));
        const answer = await pc.current.createAnswer();
        await pc.current.setLocalDescription(answer);
        socket.current?.emit("webrtc_signal", { roomId: currentRoom.current, signal: answer });
      } else if (signal.type === "answer") {
        await pc.current.setRemoteDescription(new RTCSessionDescription(signal));
      } else if (signal.type === "ice") {
        await pc.current.addIceCandidate(new RTCIceCandidate(signal.candidate));
      }
    });

    return () => pc.current?.close();
  }, [view]);

  const handleFindMatch = () => {
    setStatus("Searching for a peer...");
    if (remoteVideo.current) remoteVideo.current.srcObject = null;
    socket.current?.emit("join_queue", { domain });
  };

  if (view === "home") {
    return (
      <main className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center p-6">
        <div className="max-w-md w-full flex flex-col gap-6 items-center">
          <div className="flex flex-col items-center gap-2 mb-4">
            <span className="text-6xl mb-2">🦆</span>
            <h1 className="text-5xl font-black tracking-tight text-amber-400">Quack</h1>
            <p className="text-slate-400 text-center text-sm">Choose your connection mode.</p>
          </div>
          <button onClick={handleGlobalChat} className="w-full py-4 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-2xl flex flex-col items-center justify-center gap-1 transition">
            <span className="font-bold text-lg text-white">Start Talking</span>
            <span className="text-xs text-slate-400">Talk to anyone in the world. No login required.</span>
          </button>
          <button onClick={() => setView("login")} className="w-full py-4 bg-amber-400 hover:bg-amber-300 text-slate-950 rounded-2xl flex flex-col items-center justify-center gap-1 transition shadow-lg shadow-amber-400/20">
            <span className="font-bold text-lg">Talk to a College Peer</span>
            <span className="text-xs text-slate-800 font-medium">Verify your university email to join.</span>
          </button>
        </div>
      </main>
    );
  }

  if (view === "login" || view === "otp") {
    return (
      <main className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center p-6">
        <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl relative">
          <button onClick={() => setView("home")} className="absolute top-4 left-4 text-slate-400 hover:text-white text-sm">&larr; Back</button>
          <div className="flex items-center justify-center gap-3 mb-6 mt-4">
            <span className="text-4xl">🦆</span>
            <h2 className="text-2xl font-black tracking-tight text-amber-400">{view === "login" ? "College Peers" : "Verify Email"}</h2>
          </div>
          
          {view === "login" ? (
            <form onSubmit={handleRequestOtp} className="flex flex-col gap-4">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@yourcollege.edu" required className="w-full px-4 py-3 bg-slate-800 border border-slate-700 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-400 text-sm" />
              {error && <p className="text-red-400 text-xs">{error}</p>}
              <button type="submit" className="w-full py-3 bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold rounded-xl transition">Send Code</button>
            </form>
          ) : (
            <form onSubmit={handleVerifyOtp} className="flex flex-col gap-4">
              <p className="text-slate-400 text-xs text-center">We sent a 6-digit code to {email}</p>
              <input type="text" value={otp} onChange={(e) => setOtp(e.target.value)} placeholder="123456" required maxLength={6} className="w-full px-4 py-3 bg-slate-800 border border-slate-700 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-400 text-center tracking-[0.5em] text-lg font-mono" />
              {error && <p className="text-red-400 text-xs">{error}</p>}
              <button type="submit" className="w-full py-3 bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold rounded-xl transition">Verify & Enter</button>
            </form>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 text-white p-6 flex flex-col items-center justify-between">
      <header className="w-full max-w-5xl flex justify-between items-center mb-4">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-2xl">🦆</span>
            <span className="font-bold text-amber-400 text-xl">Quack</span>
          </div>
          <button onClick={handleLogout} className="text-xs text-slate-400 hover:text-white bg-slate-900 px-3 py-1 rounded-md border border-slate-700">
            {domain === "global" ? "Leave Room" : "Log Out"}
          </button>
        </div>
        <span className="text-xs font-mono bg-slate-800 px-3 py-1 rounded-full text-slate-300 border border-slate-700 uppercase tracking-wider">
          {domain === "global" ? "Global Network" : `Campus: ${domain}`}
        </span>
      </header>

      <div className="w-full max-w-5xl grid grid-cols-1 md:grid-cols-2 gap-4 my-auto">
        <div className="relative bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden aspect-video flex items-center justify-center">
          <video ref={localVideo} autoPlay muted playsInline className="w-full h-full object-cover" />
        </div>
        <div className="relative bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden aspect-video flex items-center justify-center">
          <video ref={remoteVideo} autoPlay playsInline className="w-full h-full object-cover" />
          <span className="absolute bottom-3 left-3 bg-slate-950/80 px-2.5 py-1 rounded-md text-xs font-medium">Peer ({status})</span>
        </div>
      </div>

      <footer className="w-full max-w-5xl flex justify-center gap-4 mt-4">
        <button onClick={handleFindMatch} className="px-8 py-3 bg-amber-400 hover:bg-amber-300 text-slate-950 font-extrabold rounded-full transition shadow-lg shadow-amber-400/20">Find Match</button>
      </footer>
    </main>
  );
}