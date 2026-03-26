/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from 'react';
import { GoogleGenAI } from "@google/genai";
import { auth, db, googleProvider } from './firebase';
import { signInWithPopup, signOut, onAuthStateChanged, User } from 'firebase/auth';
import { collection, addDoc, query, orderBy, onSnapshot, doc, setDoc, serverTimestamp, deleteDoc } from 'firebase/firestore';
import { useAuthState } from 'react-firebase-hooks/auth';
import { useCollection } from 'react-firebase-hooks/firestore';
import { 
  Camera, 
  Leaf, 
  MessageSquare, 
  Plus, 
  LogOut, 
  Trash2, 
  ChevronRight, 
  Loader2, 
  Send,
  History,
  Info,
  Droplets,
  Sun,
  Thermometer
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import Markdown from 'react-markdown';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Utility for tailwind classes
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Gemini initialization
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

// --- Types ---
enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

interface Plant {
  id?: string;
  userId: string;
  name: string;
  scientificName: string;
  description: string;
  careInstructions: string;
  imageUrl: string;
  identifiedAt: string;
}

interface ChatMessage {
  id?: string;
  userId: string;
  role: 'user' | 'model';
  content: string;
  timestamp: string;
}

// --- Components ---

function LoadingScreen() {
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center bg-emerald-50 z-50">
      <motion.div
        animate={{ rotate: 360 }}
        transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
      >
        <Leaf className="w-12 h-12 text-emerald-600" />
      </motion.div>
      <p className="mt-4 text-emerald-800 font-medium animate-pulse">Growing your garden assistant...</p>
    </div>
  );
}

function LoginScreen() {
  const handleLogin = () => signInWithPopup(auth, googleProvider);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-emerald-50 p-6">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-md w-full bg-white rounded-3xl shadow-xl p-8 text-center border border-emerald-100"
      >
        <div className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-6">
          <Leaf className="w-10 h-10 text-emerald-600" />
        </div>
        <h1 className="text-3xl font-bold text-emerald-900 mb-2">FloraGuide</h1>
        <p className="text-emerald-600 mb-8">Your AI-powered gardening companion. Identify plants and get expert care advice.</p>
        
        <button
          onClick={handleLogin}
          className="w-full py-4 px-6 bg-emerald-600 hover:bg-emerald-700 text-white rounded-2xl font-semibold transition-all flex items-center justify-center gap-3 shadow-lg shadow-emerald-200"
        >
          <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" className="w-6 h-6 bg-white rounded-full p-1" />
          Continue with Google
        </button>
        
        <p className="mt-6 text-xs text-emerald-400">By continuing, you agree to our terms of service.</p>
      </motion.div>
    </div>
  );
}

export default function App() {
  const [user, loading, error] = useAuthState(auth);
  const [activeTab, setActiveTab] = useState<'collection' | 'identify' | 'chat'>('collection');
  const [isIdentifying, setIsIdentifying] = useState(false);
  const [identificationResult, setIdentificationResult] = useState<Partial<Plant> | null>(null);
  const [chatInput, setChatInput] = useState('');
  const [isChatting, setIsChatting] = useState(false);

  // Firestore Collections
  const plantsRef = user ? collection(db, 'users', user.uid, 'plants') : null;
  const chatsRef = user ? collection(db, 'users', user.uid, 'chats') : null;

  const [plantsSnap] = useCollection(plantsRef ? query(plantsRef, orderBy('identifiedAt', 'desc')) : null);
  const [chatsSnap] = useCollection(chatsRef ? query(chatsRef, orderBy('timestamp', 'asc')) : null);

  const plants = plantsSnap?.docs.map(doc => ({ id: doc.id, ...doc.data() } as Plant)) || [];
  const chatMessages = chatsSnap?.docs.map(doc => ({ id: doc.id, ...doc.data() } as ChatMessage)) || [];

  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  if (loading) return <LoadingScreen />;
  if (error) return <div className="p-4 text-red-500">Error: {error.message}</div>;
  if (!user) return <LoginScreen />;

  const handleIdentify = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsIdentifying(true);
    setIdentificationResult(null);

    try {
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64Data = (reader.result as string).split(',')[1];
        
        const prompt = `Identify this plant. Provide the following information in a structured JSON format:
        {
          "name": "Common Name",
          "scientificName": "Scientific Name",
          "description": "Short description of the plant",
          "careInstructions": "Detailed care instructions including watering, light, and temperature needs"
        }`;

        const result = await genAI.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: [{
            parts: [
              { text: prompt },
              { inlineData: { data: base64Data, mimeType: file.type } }
            ]
          }],
          config: { responseMimeType: "application/json" }
        });

        const data = JSON.parse(result.text);
        setIdentificationResult({
          ...data,
          imageUrl: reader.result as string,
          userId: user.uid,
          identifiedAt: new Date().toISOString()
        });
        setIsIdentifying(false);
      };
      reader.readAsDataURL(file);
    } catch (err) {
      console.error("Identification error:", err);
      setIsIdentifying(false);
      alert("Failed to identify plant. Please try again.");
    }
  };

  const savePlant = async () => {
    if (!identificationResult || !plantsRef) return;
    try {
      await addDoc(plantsRef, identificationResult);
      setIdentificationResult(null);
      setActiveTab('collection');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'users/' + user.uid + '/plants');
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || !chatsRef || isChatting) return;

    const userMsg: ChatMessage = {
      userId: user.uid,
      role: 'user',
      content: chatInput,
      timestamp: new Date().toISOString()
    };

    setChatInput('');
    setIsChatting(true);

    try {
      await addDoc(chatsRef, userMsg);

      // Prepare history
      const history = (chatMessages || []).slice(-10).map(m => ({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.content }]
      }));

      const result = await genAI.models.generateContent({ 
        model: "gemini-3-flash-preview",
        contents: [...history.map(h => ({ role: h.role, parts: h.parts })), { role: 'user', parts: [{ text: chatInput }] }],
        config: {
          systemInstruction: "You are a friendly and expert gardening assistant named Flora. You help users with plant care, troubleshooting pests, and general gardening advice. Keep your answers concise and helpful."
        }
      });
      
      const modelMsg: ChatMessage = {
        userId: user.uid,
        role: 'model',
        content: result.text,
        timestamp: new Date().toISOString()
      };

      await addDoc(chatsRef, modelMsg);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'users/' + user.uid + '/chats');
    } finally {
      setIsChatting(false);
    }
  };

  const deletePlant = async (id: string) => {
    if (!plantsRef) return;
    try {
      await deleteDoc(doc(plantsRef, id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, 'users/' + user.uid + '/plants/' + id);
    }
  };

  return (
    <div className="min-h-screen bg-emerald-50/30 flex flex-col font-sans text-emerald-950">
      {/* Header */}
      <header className="bg-white border-b border-emerald-100 px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <Leaf className="w-6 h-6 text-emerald-600" />
          <span className="text-xl font-bold tracking-tight">FloraGuide</span>
        </div>
        <div className="flex items-center gap-4">
          <div className="hidden sm:flex flex-col items-end">
            <span className="text-sm font-medium">{user.displayName}</span>
            <span className="text-xs text-emerald-500">{user.email}</span>
          </div>
          <button 
            onClick={() => signOut(auth)}
            className="p-2 hover:bg-emerald-50 rounded-full transition-colors text-emerald-600"
            title="Sign Out"
          >
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-hidden flex flex-col max-w-4xl mx-auto w-full">
        <AnimatePresence mode="wait">
          {activeTab === 'collection' && (
            <motion.div 
              key="collection"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="p-6 flex-1 overflow-y-auto"
            >
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-2xl font-bold">My Plants</h2>
                <button 
                  onClick={() => setActiveTab('identify')}
                  className="bg-emerald-600 text-white px-4 py-2 rounded-xl flex items-center gap-2 text-sm font-semibold shadow-md shadow-emerald-100"
                >
                  <Plus className="w-4 h-4" /> Add Plant
                </button>
              </div>

              {(!plants || plants.length === 0) ? (
                <div className="bg-white rounded-3xl p-12 text-center border border-dashed border-emerald-200">
                  <div className="w-16 h-16 bg-emerald-50 rounded-full flex items-center justify-center mx-auto mb-4">
                    <History className="w-8 h-8 text-emerald-300" />
                  </div>
                  <h3 className="text-lg font-semibold mb-1">No plants yet</h3>
                  <p className="text-emerald-500 text-sm">Identify your first plant to start your collection.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {plants.map((plant: any) => (
                    <motion.div 
                      layout
                      key={plant.id}
                      className="bg-white rounded-3xl overflow-hidden shadow-sm border border-emerald-50 group hover:shadow-md transition-shadow"
                    >
                      <div className="relative h-48">
                        <img 
                          src={plant.imageUrl} 
                          alt={plant.name} 
                          className="w-full h-full object-cover"
                          referrerPolicy="no-referrer"
                        />
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            if (window.confirm('Are you sure you want to remove this plant from your collection?')) {
                              deletePlant(plant.id);
                            }
                          }}
                          className="absolute top-3 right-3 p-2 bg-white/90 backdrop-blur-sm rounded-full text-red-500 shadow-sm hover:bg-red-50 transition-colors z-10"
                          title="Remove from collection"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                      <div className="p-5">
                        <h3 className="font-bold text-lg leading-tight mb-1">{plant.name}</h3>
                        <p className="text-xs italic text-emerald-600 mb-3">{plant.scientificName}</p>
                        <p className="text-sm text-emerald-800 line-clamp-2 mb-4">{plant.description}</p>
                        <div className="flex gap-2">
                          <button 
                            onClick={() => {
                              setIdentificationResult(plant);
                              setActiveTab('identify');
                            }}
                            className="flex-1 py-2 bg-emerald-50 text-emerald-700 rounded-xl text-xs font-bold hover:bg-emerald-100 transition-colors"
                          >
                            View Care
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}
            </motion.div>
          )}

          {activeTab === 'identify' && (
            <motion.div 
              key="identify"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="p-6 flex-1 overflow-y-auto"
            >
              <h2 className="text-2xl font-bold mb-6">Identify Plant</h2>
              
              {!identificationResult ? (
                <div className="bg-white rounded-3xl p-8 border-2 border-dashed border-emerald-200 flex flex-col items-center justify-center min-h-[400px]">
                  {isIdentifying ? (
                    <div className="text-center">
                      <Loader2 className="w-12 h-12 text-emerald-600 animate-spin mx-auto mb-4" />
                      <p className="font-semibold text-emerald-800">Analyzing your plant...</p>
                      <p className="text-sm text-emerald-500">Gemini is looking at the leaves and stems.</p>
                    </div>
                  ) : (
                    <div className="text-center">
                      <div className="w-20 h-20 bg-emerald-50 rounded-full flex items-center justify-center mx-auto mb-6">
                        <Camera className="w-10 h-10 text-emerald-400" />
                      </div>
                      <h3 className="text-xl font-bold mb-2">Take a Photo</h3>
                      <p className="text-emerald-600 mb-8 max-w-xs mx-auto">Upload a clear photo of the plant's leaves or flowers for the best results.</p>
                      
                      <label className="bg-emerald-600 text-white px-8 py-4 rounded-2xl font-bold cursor-pointer hover:bg-emerald-700 transition-all shadow-lg shadow-emerald-100 inline-flex items-center gap-2">
                        <Plus className="w-5 h-5" />
                        Select Photo
                        <input type="file" accept="image/*" className="hidden" onChange={handleIdentify} />
                      </label>
                    </div>
                  )}
                </div>
              ) : (
                <div className="bg-white rounded-3xl overflow-hidden shadow-xl border border-emerald-100">
                  <div className="relative h-64 sm:h-80">
                    <img 
                      src={identificationResult.imageUrl} 
                      alt="Identified plant" 
                      className="w-full h-full object-cover"
                      referrerPolicy="no-referrer"
                    />
                    <button 
                      onClick={() => setIdentificationResult(null)}
                      className="absolute top-4 left-4 p-2 bg-white/80 backdrop-blur-sm rounded-full text-emerald-900 shadow-sm"
                    >
                      <ChevronRight className="w-5 h-5 rotate-180" />
                    </button>
                  </div>
                  
                  <div className="p-6 sm:p-8">
                    <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
                      <div>
                        <h3 className="text-3xl font-bold text-emerald-900 leading-tight">{identificationResult.name}</h3>
                        <p className="text-lg italic text-emerald-600">{identificationResult.scientificName}</p>
                      </div>
                      {identificationResult.id ? (
                        <button 
                          onClick={() => {
                            if (window.confirm('Are you sure you want to remove this plant from your collection?')) {
                              deletePlant(identificationResult.id!);
                              setIdentificationResult(null);
                              setActiveTab('collection');
                            }
                          }}
                          className="bg-red-50 text-red-600 px-6 py-3 rounded-2xl font-bold hover:bg-red-100 transition-all border border-red-100 flex items-center gap-2"
                        >
                          <Trash2 className="w-5 h-5" />
                          Remove from Collection
                        </button>
                      ) : (
                        <button 
                          onClick={savePlant}
                          className="bg-emerald-600 text-white px-6 py-3 rounded-2xl font-bold hover:bg-emerald-700 transition-all shadow-lg shadow-emerald-100"
                        >
                          Save to Collection
                        </button>
                      )}
                    </div>

                    <div className="space-y-8">
                      <section>
                        <h4 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-emerald-400 mb-3">
                          <Info className="w-4 h-4" /> About
                        </h4>
                        <p className="text-emerald-800 leading-relaxed">{identificationResult.description}</p>
                      </section>

                      <section className="bg-emerald-50/50 rounded-2xl p-6">
                        <h4 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-emerald-600 mb-4">
                          <Droplets className="w-4 h-4" /> Care Instructions
                        </h4>
                        <div className="prose prose-emerald max-w-none prose-sm">
                          <Markdown>{identificationResult.careInstructions}</Markdown>
                        </div>
                      </section>
                    </div>
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {activeTab === 'chat' && (
            <motion.div 
              key="chat"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="flex-1 flex flex-col h-full overflow-hidden"
            >
              {/* Chat Messages */}
              <div className="flex-1 overflow-y-auto p-6 space-y-4">
                {(!chatMessages || chatMessages.length === 0) && (
                  <div className="flex flex-col items-center justify-center h-full text-center opacity-50 py-12">
                    <MessageSquare className="w-12 h-12 mb-4" />
                    <p className="font-medium">Ask Flora anything about gardening!</p>
                    <p className="text-sm">"How often should I water my succulents?"</p>
                  </div>
                )}
                {chatMessages?.map((msg: any) => (
                  <div 
                    key={msg.id} 
                    className={cn(
                      "flex w-full",
                      msg.role === 'user' ? "justify-end" : "justify-start"
                    )}
                  >
                    <div className={cn(
                      "max-w-[85%] rounded-2xl px-4 py-3 text-sm shadow-sm",
                      msg.role === 'user' 
                        ? "bg-emerald-600 text-white rounded-tr-none" 
                        : "bg-white text-emerald-900 rounded-tl-none border border-emerald-50"
                    )}>
                      <div className="prose prose-sm prose-invert max-w-none">
                        <Markdown>{msg.content}</Markdown>
                      </div>
                    </div>
                  </div>
                ))}
                {isChatting && (
                  <div className="flex justify-start">
                    <div className="bg-white border border-emerald-50 rounded-2xl rounded-tl-none px-4 py-3 shadow-sm">
                      <div className="flex gap-1">
                        <motion.div animate={{ opacity: [0.4, 1, 0.4] }} transition={{ repeat: Infinity, duration: 1 }} className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />
                        <motion.div animate={{ opacity: [0.4, 1, 0.4] }} transition={{ repeat: Infinity, duration: 1, delay: 0.2 }} className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />
                        <motion.div animate={{ opacity: [0.4, 1, 0.4] }} transition={{ repeat: Infinity, duration: 1, delay: 0.4 }} className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />
                      </div>
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              {/* Chat Input */}
              <div className="p-4 bg-white border-t border-emerald-100">
                <form onSubmit={handleSendMessage} className="flex gap-2 max-w-2xl mx-auto">
                  <input 
                    type="text" 
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="Ask Flora..."
                    className="flex-1 bg-emerald-50 border-none rounded-2xl px-4 py-3 text-sm focus:ring-2 focus:ring-emerald-500 outline-none"
                  />
                  <button 
                    type="submit"
                    disabled={!chatInput.trim() || isChatting}
                    className="bg-emerald-600 text-white p-3 rounded-2xl hover:bg-emerald-700 transition-colors disabled:opacity-50 shadow-md shadow-emerald-100"
                  >
                    <Send className="w-5 h-5" />
                  </button>
                </form>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Bottom Navigation */}
      <nav className="bg-white border-t border-emerald-100 px-6 py-3 flex items-center justify-around sm:justify-center sm:gap-12 sticky bottom-0 z-10">
        <button 
          onClick={() => setActiveTab('collection')}
          className={cn(
            "flex flex-col items-center gap-1 transition-colors",
            activeTab === 'collection' ? "text-emerald-600" : "text-emerald-300 hover:text-emerald-400"
          )}
        >
          <Leaf className="w-6 h-6" />
          <span className="text-[10px] font-bold uppercase tracking-widest">Garden</span>
        </button>
        <button 
          onClick={() => setActiveTab('identify')}
          className={cn(
            "flex flex-col items-center gap-1 transition-colors",
            activeTab === 'identify' ? "text-emerald-600" : "text-emerald-300 hover:text-emerald-400"
          )}
        >
          <Camera className="w-6 h-6" />
          <span className="text-[10px] font-bold uppercase tracking-widest">Identify</span>
        </button>
        <button 
          onClick={() => setActiveTab('chat')}
          className={cn(
            "flex flex-col items-center gap-1 transition-colors",
            activeTab === 'chat' ? "text-emerald-600" : "text-emerald-300 hover:text-emerald-400"
          )}
        >
          <MessageSquare className="w-6 h-6" />
          <span className="text-[10px] font-bold uppercase tracking-widest">Flora</span>
        </button>
      </nav>
    </div>
  );
}
