"use client";
import { useState, useRef, useEffect } from "react";
import { io, Socket } from "socket.io-client";
import { GoogleOAuthProvider, GoogleLogin } from "@react-oauth/google";
import { jwtDecode } from "jwt-decode";

export default function Home() {
  const [view, setView] = useState<"home" | "login" | "otp" | "chat">("home");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");
  const [domain, setDomain] = useState("");
  const [status, setStatus] = useState("Idle");
  
  const [messages, setMessages] = useState<{sender: "me" | "peer", text: string}[]>([]);
  const [chatInput, setChatInput] = useState("");

  const localVideo = useRef<HTMLVideoElement>(null);
  const remoteVideo = useRef<HTMLVideoElement>(null);
  
  // WebRTC & Networking Refs
  const pc = useRef<RTCPeerConnection | null>(null);
  const socket = useRef<Socket | null>(null);
  const currentRoom = useRef<string | null>(null);
  const dataChannel = useRef<RTCDataChannel | null>(null);
  const localStream = useRef<MediaStream | null>(null); // Keeps camera on between matches

  useEffect(() => {
    const savedDomain = localStorage.getItem("quack_domain");
    if (savedDomain) {
      setDomain(savedDomain);
      setView("chat");
    }
    socket.current = io(process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:3001");
    return () => { socket.current?.disconnect(); };
  }, []);

  // --- AUTH HANDLERS ---
  const handleGoogleSuccess = (credentialResponse: any) => {
    if (credentialResponse.credential) {
      const decoded: any = jwtDecode(credentialResponse.credential);
      const parts = decoded.email.split("@");
      
      if (parts.length !== 2 || (!parts[1].endsWith(".edu") && !parts[1].endsWith(".ac.in"))) {
        setError("Please use a valid college Google account (.edu or .ac.in)");
        return;
      }
      
      setError("");
      const userDomain = parts[1].toLowerCase();
      localStorage.setItem("quack_domain", userDomain);
      setDomain(userDomain);
      setView("chat");
    }
  };

  const handleRequestOtp = (e: React.FormEvent) => {
    e.preventDefault();
    const parts = email.split("@");
    if (parts.length !== 2 || (!parts[1].endsWith(".edu") && !parts[1].endsWith(".ac.in"))) {
      setError("Please use a valid college email (.edu or .ac.in)");
      return;
    }
    if (!socket.current?.connected) {
      setError("Connecting to server... Please wait a few seconds and try again.");
      return;
    }
    setError("");
    socket.current?.emit("request_otp", { email });
    socket.current?.once("otp_sent", () => setView("otp"));
  };

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
    setMessages([]);
    dataChannel.current = null;
    if (remoteVideo.current) remoteVideo.current.srcObject = null;
    pc.current?.close();
  };

  // --- WEBRTC CORE LOGIC ---
  useEffect(() => {
    if (view !== "chat" || !socket.current) return;

    // 1. Get Camera once when entering the room
    if (!localStream.current) {
      navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then((stream) => {
        localStream.current = stream;
        if (localVideo.current) localVideo.current.srcObject = stream;
      }).catch(console.error);
    }

    // 2. Helper to build a completely fresh WebRTC Connection
    const createPeerConnection = () => {
      if (pc.current) pc.current.close(); // Destroy old connection entirely
      
      const peer = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });

      // Add local media tracks
      if (localStream.current) {
        localStream.current.getTracks().forEach((track) => peer.addTrack(track, localStream.current!));
      }

      peer.ontrack = (event) => {
        if (remoteVideo.current) remoteVideo.current.srcObject = event.streams[0];
      };

      peer.onicecandidate = (event) => {
        if (event.candidate && currentRoom.current) {
          socket.current?.emit("webrtc_signal", { roomId: currentRoom.current, signal: { type: "ice", candidate: event.candidate } });
        }
      };

      peer.ondatachannel = (event) => {
        const receiveChannel = event.channel;
        receiveChannel.onmessage = (e) => setMessages((prev) => [...prev, { sender: "peer", text: e.data }]);
        dataChannel.current = receiveChannel;
      };

      pc.current = peer;
      return peer;
    };

    // 3. Socket Event Listeners
    const onMatchFound = async ({ roomId, initiate }: { roomId: string, initiate: boolean }) => {
      currentRoom.current = roomId;
      setStatus("Connected");
      setMessages([]);
      
      const peer = createPeerConnection();

      if (initiate) {
        const dc = peer.createDataChannel("chat");
        dc.onmessage = (e) => setMessages((prev) => [...prev, { sender: "peer", text: e.data }]);
        dataChannel.current = dc;

        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        socket.current?.emit("webrtc_signal", { roomId, signal: offer });
      }
    };

    const onSignal = async (signal: any) => {
      if (!pc.current) return;
      try {
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
      } catch (err) {
        console.error("WebRTC Handshake Error:", err);
      }
    };

    socket.current.on("match_found", onMatchFound);
    socket.current.on("webrtc_signal", onSignal);

    return () => {
      socket.current?.off("match_found", onMatchFound);
      socket.current?.off("webrtc_signal", onSignal);
      pc.current?.close();
    };
  }, [view]);

  const handleFindMatch = () => {
    setStatus("Searching...");
    setMessages([]);
    if (remoteVideo.current) remoteVideo.current.srcObject = null;
    
    // Purge the old connection instantly so no cross-peer data leaks
    if (pc.current) {
      pc.current.close();
      pc.current = null;
    }
    
    socket.current?.emit("join_queue", { domain });
  };

  const sendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || !dataChannel.current || dataChannel.current.readyState !== "open") return;
    
    dataChannel.current.send(chatInput);
    setMessages((prev) => [...prev, { sender: "me", text: chatInput }]);
    setChatInput("");
  };

  // --- RENDERS ---
  if (view === "home") {
    return (
      <main className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center p-6">
        <div className="max-w-md w-full flex flex-col gap-6 items-center">
          <div className="flex flex-col items-center gap-2 mb-4">
            <span className="text-6xl mb-2">🦆</span>
            <h1 className="text-5xl font-black tracking-tight text-amber-400">Quack</h1>
            <p className="text-slate-400 text-center text-sm">Choose your connection mode.</p>
          </div>
          <button onClick={() => { setDomain("global"); setView("chat"); }} className="w-full py-4 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-2xl flex flex-col items-center justify-center gap-1 transition">
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
            <div className="flex flex-col gap-4">
              <GoogleOAuthProvider clientId={process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || ""}>
                <div className="flex justify-center w-full">
                  <GoogleLogin onSuccess={handleGoogleSuccess} onError={() => setError("Google Login Failed")} />
                </div>
              </GoogleOAuthProvider>
              <div className="flex items-center gap-2 my-2">
                <div className="h-px bg-slate-800 flex-1"></div>
                <span className="text-xs text-slate-500 font-medium uppercase tracking-widest">OR</span>
                <div className="h-px bg-slate-800 flex-1"></div>
              </div>
              <form onSubmit={handleRequestOtp} className="flex flex-col gap-4">
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@yourcollege.edu" required className="w-full px-4 py-3 bg-slate-800 border border-slate-700 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-400 text-sm" />
                {error && <p className="text-red-400 text-xs text-center">{error}</p>}
                <button type="submit" className="w-full py-3 bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold rounded-xl transition">Send Code</button>
              </form>
            </div>
          ) : (
            <form onSubmit={handleVerifyOtp} className="flex flex-col gap-4">
              <p className="text-slate-400 text-xs text-center">We sent a 6-digit code to {email}</p>
              <input type="text" value={otp} onChange={(e) => setOtp(e.target.value)} placeholder="123456" required maxLength={6} className="w-full px-4 py-3 bg-slate-800 border border-slate-700 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-400 text-center tracking-[0.5em] text-lg font-mono" />
              {error && <p className="text-red-400 text-xs text-center">{error}</p>}
              <button type="submit" className="w-full py-3 bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold rounded-xl transition">Verify & Enter</button>
            </form>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 text-white p-4 md:p-6 flex flex-col items-center">
      <header className="w-full max-w-6xl flex justify-between items-center mb-6">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-2xl">🦆</span>
            <span className="font-bold text-amber-400 text-xl hidden sm:block">Quack</span>
          </div>
          <button onClick={handleLogout} className="text-xs text-slate-400 hover:text-white bg-slate-900 px-3 py-1.5 rounded-md border border-slate-700">
            {domain === "global" ? "Leave Room" : "Log Out"}
          </button>
        </div>
        <div className="flex items-center gap-4">
          <button onClick={handleFindMatch} className="px-6 py-1.5 text-sm bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold rounded-full transition shadow-lg shadow-amber-400/20">
            Next Peer
          </button>
          <span className="text-xs font-mono bg-slate-800 px-3 py-1.5 rounded-full text-slate-300 border border-slate-700 uppercase tracking-wider hidden md:block">
            {domain === "global" ? "Global Network" : `Campus: ${domain}`}
          </span>
        </div>
      </header>

      <div className="w-full max-w-6xl flex flex-col-reverse lg:flex-row gap-6 h-[75vh]">
        <div className="w-full lg:w-1/3 bg-slate-900 border border-slate-800 rounded-2xl flex flex-col overflow-hidden h-[40vh] lg:h-full shrink-0 shadow-2xl">
          <div className="p-4 bg-slate-950/50 border-b border-slate-800 flex justify-between items-center">
            <span className="font-bold text-amber-400">Live Chat</span>
            <span className={`text-xs px-2 py-1 rounded-md ${status === "Connected" ? "bg-green-500/20 text-green-400" : "bg-slate-800 text-slate-400"}`}>
              {status}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
            {messages.length === 0 && (
              <p className="text-slate-500 text-xs text-center my-auto">Messages will appear here when connected.</p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`px-4 py-2 rounded-2xl max-w-[85%] text-sm ${
                m.sender === "me" ? "bg-amber-400 text-slate-950 self-end rounded-br-sm" : "bg-slate-800 text-white self-start rounded-bl-sm border border-slate-700"
              }`}>
                {m.text}
              </div>
            ))}
          </div>
          <form onSubmit={sendMessage} className="p-3 border-t border-slate-800 flex gap-2 bg-slate-900/50">
            <input 
              type="text" value={chatInput} onChange={e => setChatInput(e.target.value)} disabled={status !== "Connected"}
              placeholder={status === "Connected" ? "Type a message..." : "Waiting for peer..."}
              className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400 disabled:opacity-50"
            />
            <button type="submit" disabled={status !== "Connected" || !chatInput.trim()} className="bg-amber-400 hover:bg-amber-300 text-slate-950 px-5 py-2.5 rounded-xl font-bold disabled:opacity-50 disabled:cursor-not-allowed transition">
              Send
            </button>
          </form>
        </div>

        <div className="w-full lg:w-2/3 flex flex-col gap-4">
          <div className="relative bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden flex-1 flex items-center justify-center shadow-2xl">
            <video ref={remoteVideo} autoPlay playsInline className="w-full h-full object-cover" />
            <span className="absolute bottom-4 left-4 bg-slate-950/80 px-3 py-1.5 rounded-lg text-xs font-medium backdrop-blur-md shadow-xl border border-slate-800/50">
              Peer ({status})
            </span>
          </div>
          <div className="relative bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden h-32 md:h-56 shrink-0 flex items-center justify-center shadow-2xl">
            <video ref={localVideo} autoPlay muted playsInline className="w-full h-full object-cover" />
            <span className="absolute bottom-4 left-4 bg-slate-950/80 px-3 py-1.5 rounded-lg text-xs font-medium backdrop-blur-md shadow-xl border border-slate-800/50">
              You
            </span>
          </div>
        </div>
      </div>
    </main>
  );
}