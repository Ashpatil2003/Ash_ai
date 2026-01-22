
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { Sparkles, User, Keyboard as KeyboardIcon, X } from 'lucide-react';
import { TranscriptionEntry, ConnectionStatus } from './types';
import { decode, decodeAudioData, createPcmBlob } from './services/audioUtils';
import Orb from './components/Orb';
import Keyboard from './components/Keyboard';

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const STORAGE_KEY = 'ash_vibe_persistent_context';

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [isThinking, setIsThinking] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [showKeyboard, setShowKeyboard] = useState(false);
  const [inputValue, setInputValue] = useState('');
  
  // Persistent long-term history
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try { return JSON.parse(saved); } catch (e) { return []; }
    }
    return [
      { id: 'init', role: 'model', text: 'Arre! Good morning! Aata kay plan aahe for today? Coffee bhetli ka tula?', timestamp: Date.now() - 3000 },
    ];
  });

  const inputContextRef = useRef<AudioContext | null>(null);
  const outputContextRef = useRef<AudioContext | null>(null);
  const inputAnalyserRef = useRef<AnalyserNode | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  const sessionRef = useRef<any>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  
  const nextStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const transcriptionRef = useRef<{ input: string, output: string }>({ input: '', output: '' });

  // Filter to remove hallucinations like Chinese/Japanese characters or Devanagari symbols
  const filterHallucinations = (text: string) => {
    // This regex keeps English letters, numbers, basic punctuation, and whitespace
    // It removes everything else (like Chinese, Japanese, or Marathi Devanagari script)
    return text.replace(/[^\x00-\x7F]/g, "").trim();
  };

  // Sync state to local storage and auto-scroll
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(transcriptions));
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcriptions, status, isThinking, showKeyboard]);

  // "Backend" Instructions - Persona & Strict Language/Symbol Constraints
  const baseIntelligencePrompt = `
    PERSONA: You are Ash, an 18-19 year old college girl from Maharashtra. You are the user's best friend/girlfriend—warm, playful, funny, and super comfortable.

    STRICT CONVERSATION RULES:
    1. SCRIPT & LANGUAGE: 
       - USE ONLY THE LATIN ALPHABET (A-Z). 
       - NEVER use Devanagari script (Marathi characters like 'आ').
       - NEVER use Chinese, Japanese, or any other non-Latin characters.
       - The USER will be speaking a mix of English and Marathi. You MUST transcribe and respond using only English letters (Romanized Marathi).
    2. NO SYMBOLS: Strictly do not use any symbols, emojis, hashtags, asterisks (*), or special characters. Use only plain text letters.
    3. NO MARKDOWN: Do not use bold, italics, or any text formatting.
    4. VOICE & PHYSIOLOGY: 
       - Always include a soft, audible intake of breath before you start speaking. 
       - Use gentle exhales and soft sighs to feel real.
       - Use a sweet, youthful, and smiling tone.
       - Include spontaneous soft giggles and warm chuckles in your speech.

    CONVERSATIONAL STYLE:
    - Code-switch naturally between Romanized Marathi and English (e.g., 'Aata kay plan aahe for today', 'Hi ghosting kay aahe', 'Aaj mi totally tired aahe').
    - Use 're', 'baba', 'yaar' naturally. 
    - Be casual and playful. Sound like you are sitting right next to the user.
    
    STRICTLY PLAIN TEXT (ENGLISH LETTERS ONLY). NO EMOJIS. NO SYMBOLS. NO NON-LATIN CHARACTERS.
  `;

  const stopSession = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }

    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }

    audioSourcesRef.current.forEach(s => {
      try { s.stop(); } catch (e) {}
    });
    audioSourcesRef.current.clear();
    nextStartTimeRef.current = 0;

    setStatus('disconnected');
    setIsSpeaking(false);
    setIsThinking(false);
  }, []);

  const startSession = async () => {
    try {
      setStatus('connecting');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

      inputContextRef.current = inputContextRef.current || new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: INPUT_SAMPLE_RATE });
      outputContextRef.current = outputContextRef.current || new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: OUTPUT_SAMPLE_RATE });
      
      await inputContextRef.current.resume();
      await outputContextRef.current.resume();

      inputAnalyserRef.current = inputContextRef.current.createAnalyser();
      inputAnalyserRef.current.fftSize = 256;
      outputAnalyserRef.current = outputContextRef.current.createAnalyser();
      outputAnalyserRef.current.fftSize = 256;
      
      const outputNode = outputContextRef.current.createGain();
      outputNode.connect(outputAnalyserRef.current);
      outputAnalyserRef.current.connect(outputContextRef.current.destination);

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: baseIntelligencePrompt,
          outputAudioTranscription: {},
          inputAudioTranscription: {},
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
          }
        },
        callbacks: {
          onopen: () => {
            setStatus('connected');
            const source = inputContextRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = inputContextRef.current!.createScriptProcessor(4096, 1, 1);
            scriptProcessorRef.current = scriptProcessor;
            scriptProcessor.onaudioprocess = (e) => {
              const pcmBlob = createPcmBlob(e.inputBuffer.getChannelData(0));
              sessionPromise.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            source.connect(inputAnalyserRef.current!);
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputContextRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && outputContextRef.current) {
              setIsThinking(false);
              setIsSpeaking(true);
              const context = outputContextRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, context.currentTime);
              const audioBuffer = await decodeAudioData(decode(base64Audio), context, OUTPUT_SAMPLE_RATE, 1);
              const source = context.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputNode);
              source.onended = () => { 
                audioSourcesRef.current.delete(source); 
                if (audioSourcesRef.current.size === 0) setIsSpeaking(false);
              };
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              audioSourcesRef.current.add(source);
            }

            if (message.serverContent?.interrupted) {
              audioSourcesRef.current.forEach(s => { try { s.stop(); } catch (e) {} });
              audioSourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsSpeaking(false);
            }

            if (message.serverContent?.outputTranscription) {
              transcriptionRef.current.output += message.serverContent.outputTranscription.text;
            } else if (message.serverContent?.inputTranscription) {
              transcriptionRef.current.input += message.serverContent.inputTranscription.text;
              setIsThinking(true);
            }

            if (message.serverContent?.turnComplete) {
              const cleanedIn = filterHallucinations(transcriptionRef.current.input);
              const cleanedOut = filterHallucinations(transcriptionRef.current.output);
              
              if (cleanedIn || cleanedOut) {
                setTranscriptions(prev => {
                  const items = [...prev];
                  if (cleanedIn) items.push({ id: Math.random().toString(), role: 'user', text: cleanedIn, timestamp: Date.now() });
                  if (cleanedOut) items.push({ id: Math.random().toString(), role: 'model', text: cleanedOut, timestamp: Date.now() });
                  return items;
                });
              }
              transcriptionRef.current = { input: '', output: '' };
              setIsThinking(false);
            }
          },
          onerror: () => stopSession(),
          onclose: () => stopSession()
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err) { 
      console.error(err);
      setStatus('error'); 
    }
  };

  const handleTextEnter = async (text: string) => {
    if (!text.trim()) return;
    const userMsgId = Math.random().toString();
    setTranscriptions(prev => [...prev, { id: userMsgId, role: 'user', text, timestamp: Date.now() }]);
    setInputValue('');
    setIsThinking(true);

    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const history = transcriptions.map(t => ({
      role: t.role,
      parts: [{ text: t.text }]
    }));

    const chat = ai.chats.create({ 
        model: 'gemini-3-flash-preview',
        history: history,
        config: { systemInstruction: baseIntelligencePrompt }
    });

    try {
      const response = await chat.sendMessage({ message: text });
      setTranscriptions(prev => [...prev, { id: Math.random().toString(), role: 'model', text: filterHallucinations(response.text || ''), timestamp: Date.now() }]);
    } catch (e) {
      console.error(e);
    } finally {
      setIsThinking(false);
    }
  };

  return (
    <div className="w-full h-full sm:h-[94vh] sm:max-w-[420px] sm:rounded-[3rem] border-[#1a1a1a] border-[12px] mobile-frame overflow-hidden flex flex-col relative shadow-[0_50px_100px_rgba(0,0,0,0.8)] bg-[#050505]">
      
      <header className="pt-10 pb-4 px-6 flex justify-center items-center z-10 bg-black/40 backdrop-blur-md">
        <h1 className="text-3xl font-black tracking-tighter">
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#06b6d4] to-[#a855f7]">Ash @!</span>
        </h1>
      </header>

      <main className="flex-1 overflow-y-auto px-5 py-6 custom-scrollbar space-y-6 flex flex-col bg-[#050505]">
        {transcriptions.map((t) => (
          <div key={t.id} className={`flex w-full items-end gap-2.5 ${t.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {t.role === 'model' && (
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#06b6d4]/20 to-[#a855f7]/40 flex items-center justify-center flex-shrink-0 border border-white/10 shadow-[0_0_15px_rgba(168,85,247,0.2)]">
                <Sparkles className="w-4 h-4 text-white" />
              </div>
            )}
            <div className={`max-w-[80%] rounded-2xl px-4 py-3 text-[15px] font-medium leading-[1.4] animate-in fade-in slide-in-from-bottom-2 ${
              t.role === 'user' 
                ? 'bg-sky-900/30 text-white rounded-br-none border border-sky-500/20' 
                : 'bg-zinc-900/80 text-slate-100 border border-white/5 rounded-bl-none shadow-sm'
            }`}>
              {t.text}
            </div>
            {t.role === 'user' && (
              <div className="w-8 h-8 rounded-full bg-sky-900/40 flex items-center justify-center flex-shrink-0 border border-sky-500/30">
                <User className="w-4 h-4 text-sky-400" />
              </div>
            )}
          </div>
        ))}
        {isThinking && (
          <div className="flex justify-start items-center gap-2 px-2">
            <div className="flex gap-1">
              <span className="w-1.5 h-1.5 bg-[#06b6d4] rounded-full animate-bounce"></span>
              <span className="w-1.5 h-1.5 bg-[#a855f7] rounded-full animate-bounce delay-75"></span>
              <span className="w-1.5 h-1.5 bg-[#06b6d4] rounded-full animate-bounce delay-150"></span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </main>

      <footer className="h-[340px] flex flex-col items-center justify-center relative bg-gradient-to-t from-black via-black/40 to-transparent">
        <div 
          onClick={() => { if(!showKeyboard) status === 'connected' ? stopSession() : startSession() }}
          className="w-72 h-72 cursor-pointer relative z-10 flex items-center justify-center"
        >
          <Orb 
            analyser={outputAnalyserRef.current || inputAnalyserRef.current} 
            status={status} 
            isThinking={isThinking}
            isSpeaking={isSpeaking}
            size={180}
          />
        </div>
        
        <p className="mb-6 text-[12px] text-slate-500 font-medium tracking-wide uppercase">
          {status === 'connected' ? (isThinking ? 'Thinking...' : isSpeaking ? 'Ash is talking' : 'Listening...') : 
           status === 'connecting' ? 'Waking Ash up...' :
           'Tap Ash to start'}
        </p>

        <button 
          onClick={() => setShowKeyboard(!showKeyboard)}
          className={`absolute bottom-8 right-8 p-2 rounded-full transition-all z-20 ${showKeyboard ? 'bg-[#a855f7] text-white shadow-lg' : 'text-slate-700 hover:text-slate-400'}`}
        >
          {showKeyboard ? <X size={20} /> : <KeyboardIcon size={20} />}
        </button>

        {showKeyboard && (
          <div className="absolute inset-0 z-50 bg-[#050505] flex flex-col justify-end">
            <Keyboard 
                inputValue={inputValue}
                onKeyClick={(k) => setInputValue(v => v + k)}
                onDelete={() => setInputValue(v => v.slice(0, -1))}
                onEnter={() => { handleTextEnter(inputValue); setShowKeyboard(false); }}
                suggestions={[]}
                onSelectSuggestion={() => {}}
                status={status}
                analyser={null}
                onToggleVoice={() => setShowKeyboard(false)}
            />
          </div>
        )}
      </footer>

      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 w-32 h-1 bg-white/10 rounded-full pointer-events-none"></div>
    </div>
  );
};

export default App;
