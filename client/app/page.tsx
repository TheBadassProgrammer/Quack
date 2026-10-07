"use client";
import { useState, useRef, useEffect } from "react";
import { io, Socket } from "socket.io-client";
import { GoogleOAuthProvider, GoogleLogin } from "@react-oauth/google";
import { jwtDecode } from "jwt-decode";

export default function Home() {
  const [view, setView] = useState<"home" | "login" | "otp" | "chat">("home");
  const [authMode, setAuthMode] = useState<"college" | "global">("college");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");
  const [domain, setDomain] = useState("");
  const [status, setStatus] = useState("Idle");
  
  // Persistent DB User IDs & Friendship
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [peerUserId, setPeerUserId] = useState<string | null>(null);
  const [friendState, setFriendState] = useState<"none" | "sent" | "received" | "friends">("none");

  const [messages, setMessages] = useState<{sender: "me" | "peer", text: string}[]>([]);
  const [chatInput, setChatInput] = useState("");

  const localVideo = useRef<HTMLVideoElement>(null);
  const remoteVideo = useRef<HTMLVideoElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  
  const pc = useRef<RTCPeerConnection | null>(null);
  const socket = useRef<Socket | null>(null);
  const currentRoom = useRef<string | null>(null);
  const dataChannel = useRef<RTCDataChannel | null>(null);
  const localStream = useRef<MediaStream | null>(null);

  // Restore session from localStorage and auto-re-register on socket connection
  useEffect(() => {
    const savedDomain = localStorage.getItem("quack_domain");
    const savedUserId = localStorage.getItem("quack_userId");
    const savedEmail = localStorage.getItem("quack_email");
    const savedAuthMode = localStorage.getItem("quack_authMode") as "college" | "global";

    if (savedDomain && savedUserId && savedEmail) {
      setDomain(savedDomain);
      setMyUserId(savedUserId);
      setEmail(savedEmail);
      if (savedAuthMode) setAuthMode(savedAuthMode);
      setView("chat");
    }
    
    socket.current = io(process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:3001");

    socket.current.on("connect", () => {
      if (savedEmail && savedDomain) {
        socket.current?.emit("register_user", { email: savedEmail, domain: savedDomain }, (res: { userId: string }) => {
          if (res?.userId) {
            localStorage.setItem("quack_userId", res.userId);
            setMyUserId(res.userId);
          }
        });
      }
    });

    socket.current.on("otp_error", ({ error }: { error: string }) => {
      setError(error);
    });

    return () => { socket.current?.disconnect(); };
  }, []);

  // Transmit identity as soon as data channel opens & myUserId is ready
  useEffect(() => {
    if (myUserId && dataChannel.current && dataChannel.current.readyState === "open") {
      dataChannel.current.send(JSON.stringify({ type: "IDENTITY", userId: myUserId }));
    }
  }, [myUserId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // --- AUTH HANDLERS ---
  const handleGoogleSuccess = (credentialResponse: any) => {
    if (credentialResponse.credential) {
      const decoded: any = jwtDecode(credentialResponse.credential);
      const userEmail = decoded.email;
      const parts = userEmail.split("@");
      
      if (authMode === "college") {
        if (parts.length !== 2 || (!parts[1].endsWith(".edu") && !parts[1].endsWith(".ac.in"))) {
          setError("Please use a valid college Google account (.edu or .ac.in)");
          return;
        }
      }
      
      setError("");
      const userDomain = authMode === "global" ? "global" : parts[1].toLowerCase();

      socket.current?.emit("register_user", { email: userEmail, domain: userDomain }, (res: { userId: string }) => {
        if (res?.userId) {
          localStorage.setItem("quack_email", userEmail);
          localStorage.setItem("quack_domain", userDomain);
          localStorage.setItem("quack_userId", res.userId);
          localStorage.setItem("quack_authMode", authMode);
          
          setDomain(userDomain);
          setMyUserId(res.userId);
          setView("chat");
        } else {
          setError("Failed to register user in database.");
        }
      });
    }
  };

  const handleRequestOtp = (e: React.FormEvent) => {
    e.preventDefault();
    const parts = email.split("@");
    if (authMode === "college") {
      if (parts.length !== 2 || (!parts[1].endsWith(".edu") && !parts[1].endsWith(".ac.in"))) {
        setError("Please use a valid college email (.edu or .ac.in)");
        return;
      }
    }
    if (!socket.current?.connected) {
      setError("Connecting to server... Please wait a few seconds and try again.");
      return;
    }
    setError("");
    socket.current?.emit("request_otp", { email, mode: authMode });
    socket.current?.once("otp_sent", () => setView("otp"));
  };

  const handleVerifyOtp = (e: React.FormEvent) => {
    e.preventDefault();
    socket.current?.emit("verify_otp", { email, code: otp });
    socket.current?.once("otp_verified", (res: { success: boolean; domain?: string; error?: string }) => {
      if (res.success && res.domain) {
        const userDomain = authMode === "global" ? "global" : res.domain;

        socket.current?.emit("register_user", { email, domain: userDomain }, (ackRes: { userId: string }) => {
          if (ackRes?.userId) {
            localStorage.setItem("quack_email", email);
            localStorage.setItem("quack_domain", userDomain);
            localStorage.setItem("quack_userId", ackRes.userId);
            localStorage.setItem("quack_authMode", authMode);
            
            setDomain(userDomain);
            setMyUserId(ackRes.userId);
            setView("chat");
          } else {
            setError("Failed to register user in database.");
          }
        });
      } else {
        setError(res.error || "Invalid OTP");
      }
    });
  };

  const handleLogout = () => {
    localStorage.removeItem("quack_domain");
    localStorage.removeItem("quack_userId");
    localStorage.removeItem("quack_email");
    localStorage.removeItem("quack_authMode");
    setDomain("");
    setMyUserId(null);
    setView("home");
    setEmail("");
    setOtp("");
    setMessages([]);
    dataChannel.current = null;
    if (remoteVideo.current) remoteVideo.current.srcObject = null;
    pc.current?.close();
  };

  // --- WEBRTC & FRIEND HANDSHAKE ---
  const handleDataChannelMessage = (dataString: string) => {
    try {
      const payload = JSON.parse(dataString);
      
      if (payload.type === "IDENTITY") {
        setPeerUserId(payload.userId);
      } else if (payload.type === "CHAT") {
        setMessages((prev) => [...prev, { sender: "peer", text: payload.text }]);
      } else if (payload.type === "FRIEND_REQUEST") {
        setFriendState((prev) => {
          if (prev === "sent") {
            if (myUserId && payload.userId) {
              socket.current?.emit("add_friend", { myId: myUserId, peerId: payload.userId });
            }
            return "friends";
          }
          return "received";
        });
      }
    } catch {
      setMessages((prev) => [...prev, { sender: "peer", text: dataString }]);
    }
  };

  const handleAddFriendClick = () => {
    if (!myUserId || !peerUserId) return;

    if (friendState === "friends" || friendState === "sent") return;

    const nextState = friendState === "received" ? "friends" : "sent";
    setFriendState(nextState);

    dataChannel.current?.send(JSON.stringify({ type: "FRIEND_REQUEST", userId: myUserId }));

    if (nextState === "friends" && myUserId && peerUserId) {
      socket.current?.emit("add_friend", { myId: myUserId, peerId: peerUserId });
    }
  };

  useEffect(() => {
    if (view !== "chat" || !socket.current) return;

    if (!localStream.current) {
      navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then((stream) => {
        localStream.current = stream;
        if (localVideo.current) localVideo.current.srcObject = stream;
      }).catch(console.error);
    }

    const createPeerConnection = () => {
      if (pc.current) pc.current.close();
      const peer = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });

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
        const dc = event.channel;
        dc.onopen = () => {
          if (myUserId) dc.send(JSON.stringify({ type: "IDENTITY", userId: myUserId }));
        };
        dc.onmessage = (e) => handleDataChannelMessage(e.data);
        dataChannel.current = dc;
      };

      pc.current = peer;
      return peer;
    };

    const onMatchFound = async ({ roomId, initiate }: { roomId: string, initiate: boolean }) => {
      currentRoom.current = roomId;
      setStatus("Connected");
      setMessages([]);
      setFriendState("none");
      setPeerUserId(null);
      
      const peer = createPeerConnection();

      if (initiate) {
        const dc = peer.createDataChannel("chat");
        dc.onopen = () => {
          if (myUserId) dc.send(JSON.stringify({ type: "IDENTITY", userId: myUserId }));
        };
        dc.onmessage = (e) => handleDataChannelMessage(e.data);
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
  }, [view, myUserId]);

  const handleFindMatch = () => {
    setStatus("Searching...");
    setMessages([]);
    setFriendState("none");
    setPeerUserId(null);
    if (remoteVideo.current) remoteVideo.current.srcObject = null;
    if (pc.current) {
      pc.current.close();
      pc.current = null;
    }
    socket.current?.emit("join_queue", { domain });
  };

  const sendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || !dataChannel.current || dataChannel.current.readyState !== "open") return;
    
    dataChannel.current.send(JSON.stringify({ type: "CHAT", text: chatInput }));
    setMessages((prev) => [...prev, { sender: "me", text: chatInput }]);
    setChatInput("");
  };

  if (view === "home") {
    return (
      <main className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center p-6">
        <div className="max-w-md w-full flex flex-col gap-6 items-center">
          <div className="flex flex-col items-center gap-2 mb-4">
            <span className="text-6xl mb-2">🦆</span>
            <h1 className="text-5xl font-black tracking-tight text-amber-400">Quack</h1>
            <p className="text-slate-400 text-center text-sm">Choose how you want to connect.</p>
          </div>
          
          <button 
            onClick={() => { setAuthMode("global"); setView("login"); }} 
            className="w-full py-4 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-2xl flex flex-col items-center justify-center gap-1 transition shadow-lg"
          >
            <span className="font-bold text-lg text-white">Global Chat</span>
            <span className="text-xs text-slate-400">Log in with any email to talk worldwide.</span>
          </button>

          <button 
            onClick={() => { setAuthMode("college"); setView("login"); }} 
            className="w-full py-4 bg-amber-400 hover:bg-amber-300 text-slate-950 rounded-2xl flex flex-col items-center justify-center gap-1 transition shadow-lg shadow-amber-400/20"
          >
            <span className="font-bold text-lg">College Peer Chat</span>
            <span className="text-xs text-slate-800 font-medium">Verify your university email (.edu / .ac.in).</span>
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
            <h2 className="text-2xl font-black tracking-tight text-amber-400">
              {authMode === "college" ? "College Peer Chat" : "Global Chat Login"}
            </h2>
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
                <input 
                  type="email" 
                  value={email} 
                  onChange={(e) => setEmail(e.target.value)} 
                  placeholder={authMode === "college" ? "you@yourcollege.edu" : "you@email.com"} 
                  required 
                  className="w-full px-4 py-3 bg-slate-800 border border-slate-700 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-400 text-sm" 
                />
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
    <main className="h-[100dvh] bg-slate-950 text-white flex flex-col overflow-hidden relative">
      
      {/* HEADER */}
      <header className="absolute top-0 left-0 w-full z-40 lg:static lg:w-full lg:max-w-7xl lg:mx-auto flex justify-between items-center p-3 lg:p-6 shrink-0 bg-gradient-to-b from-black/80 to-transparent lg:bg-none pointer-events-none">
        <div className="flex items-center gap-2 md:gap-4 pointer-events-auto">
          <div className="flex items-center gap-1 md:gap-2">
            <span className="text-xl md:text-2xl">🦆</span>
            <span className="font-bold text-amber-400 text-lg md:text-xl hidden sm:block drop-shadow-md lg:drop-shadow-none">Quack</span>
          </div>
          <button onClick={handleLogout} className="text-[10px] md:text-xs text-slate-200 lg:text-slate-400 hover:text-white bg-slate-900/80 lg:bg-slate-900 px-2 py-1 md:px-3 md:py-1.5 rounded-md border border-slate-700 backdrop-blur-md lg:backdrop-blur-none">
            Log Out
          </button>
        </div>

        <div className="flex items-center gap-2 md:gap-3 pointer-events-auto">
          {status === "Connected" && (
            <button 
              onClick={handleAddFriendClick}
              className={`px-3 py-1.5 text-[11px] md:text-xs font-bold rounded-full transition shadow-lg ${
                friendState === "friends"
                  ? "bg-green-500 text-slate-950 cursor-default"
                  : friendState === "sent"
                  ? "bg-slate-700 text-amber-400 border border-amber-400/50"
                  : friendState === "received"
                  ? "bg-amber-400 text-slate-950 animate-pulse"
                  : "bg-slate-800 hover:bg-slate-700 text-white border border-slate-700"
              }`}
            >
              {friendState === "friends" ? "✓ Friends" : friendState === "sent" ? "Request Sent" : friendState === "received" ? "Accept Friend" : "+ Add Friend"}
            </button>
          )}

          <button onClick={handleFindMatch} className="px-4 py-1.5 md:px-6 md:py-1.5 text-[11px] md:text-sm bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold rounded-full transition shadow-lg shadow-amber-400/20">
            Next Peer
          </button>
        </div>
      </header>

      {/* MAIN CONTENT AREA */}
      <div className="w-full h-full lg:max-w-7xl lg:mx-auto flex flex-col lg:flex-row lg:gap-6 lg:p-6 lg:pt-0 flex-1 min-h-0 relative">
        
        {/* VIDEOS */}
        <div 
          className="relative flex-1 w-full h-full bg-black lg:rounded-2xl overflow-hidden shadow-2xl cursor-pointer lg:cursor-default"
          onClick={() => {
            if (window.innerWidth < 1024 && document.activeElement instanceof HTMLElement) {
              document.activeElement.blur();
            }
          }}
        >
          <video ref={remoteVideo} autoPlay playsInline className="w-full h-full object-cover" />
          
          <span className="absolute top-16 left-3 lg:top-auto lg:left-4 lg:bottom-4 bg-slate-950/60 lg:bg-slate-950/80 px-2.5 py-1 lg:px-3 lg:py-1.5 rounded-md lg:rounded-lg text-[10px] lg:text-xs font-medium backdrop-blur-md shadow-xl border border-slate-800/50 z-20">
            Peer ({status})
          </span>

          <div className="absolute bottom-20 right-3 lg:bottom-auto lg:right-auto lg:top-4 lg:left-4 w-24 md:w-32 lg:w-48 aspect-[3/4] bg-slate-950 border border-slate-700/50 lg:border-slate-700 rounded-lg lg:rounded-xl overflow-hidden shadow-2xl z-20 pointer-events-none">
            <video ref={localVideo} autoPlay muted playsInline className="w-full h-full object-cover scale-x-[-1]" />
            <span className="absolute bottom-1.5 left-1.5 lg:bottom-2 lg:left-2 bg-slate-950/60 lg:bg-slate-950/80 px-1.5 py-0.5 lg:px-2 lg:py-1 rounded-md text-[9px] lg:text-[10px] font-medium backdrop-blur-md border border-slate-800/50">
              You
            </span>
          </div>
        </div>

        {/* CHAT AREA */}
        <div className="absolute bottom-0 left-0 w-full h-[30%] lg:h-full lg:static z-30 flex flex-col justify-end lg:justify-start bg-gradient-to-t from-black/90 via-black/40 to-transparent pointer-events-none lg:pointer-events-auto lg:w-80 xl:w-96 shrink-0 lg:bg-none lg:bg-slate-900 lg:border lg:border-slate-800 lg:rounded-2xl lg:shadow-2xl lg:overflow-hidden">
          
          <div className="hidden lg:flex p-3 md:p-4 bg-slate-950/50 border-b border-slate-800 justify-between items-center shrink-0">
            <span className="font-bold text-amber-400 text-sm md:text-base">Live Chat</span>
            <span className={`text-[10px] md:text-xs px-2 py-1 rounded-md ${status === "Connected" ? "bg-green-500/20 text-green-400" : "bg-slate-800 text-slate-400"}`}>
              {status}
            </span>
          </div>
          
          {/* Scrollable Messages Area */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden p-3 lg:p-4 flex flex-col gap-1.5 lg:gap-3 w-full pointer-events-auto no-scrollbar mask-image-to-top">
            {messages.map((m, i) => (
              <div key={i} className={`flex w-full lg:w-fit lg:max-w-[85%] ${m.sender === "me" ? "lg:self-end" : "lg:self-start"}`}>
                
                {/* Mobile View */}
                <div className="lg:hidden text-[13px] leading-snug break-words max-w-[50%] drop-shadow-md text-white/90">
                  <span className="font-bold mr-1">
                    {m.sender === "me" ? "You:" : "Peer:"}
                  </span>
                  {m.text}
                </div>

                {/* PC View */}
                <div className={`
                  hidden lg:block text-sm leading-snug break-words
                  ${m.sender === "me" 
                    ? "text-slate-950 bg-amber-400 px-3 py-2 rounded-2xl rounded-br-sm drop-shadow-none" 
                    : "text-white bg-slate-800 px-3 py-2 rounded-2xl rounded-bl-sm border border-slate-700 drop-shadow-none"
                  }
                `}>
                  {m.text}
                </div>

              </div>
            ))}
            <div ref={messagesEndRef} className="h-px shrink-0" />
          </div>

          {/* Input Form */}
          <form onSubmit={sendMessage} className="p-3 lg:p-3 lg:border-t lg:border-slate-800 flex gap-2 lg:bg-slate-900/50 shrink-0 pointer-events-auto">
            <input 
              type="text" value={chatInput} onChange={e => setChatInput(e.target.value)} disabled={status !== "Connected"}
              placeholder={status === "Connected" ? "send a message" : "Waiting..."}
              className="flex-1 bg-black/40 lg:bg-slate-950 border border-white/20 lg:border-slate-700 rounded-full lg:rounded-xl px-4 py-2.5 text-xs lg:text-sm focus:outline-none focus:ring-1 focus:ring-amber-400 disabled:opacity-50 text-white backdrop-blur-sm lg:backdrop-blur-none"
            />
            <button type="submit" disabled={status !== "Connected" || !chatInput.trim()} className="bg-transparent lg:bg-amber-400 text-white lg:text-slate-950 px-3 lg:px-4 py-2.5 rounded-full lg:rounded-xl text-sm font-bold disabled:opacity-50 disabled:cursor-not-allowed transition hover:opacity-80">
              Send
            </button>
          </form>
        </div>

      </div>
    </main>
  );
}