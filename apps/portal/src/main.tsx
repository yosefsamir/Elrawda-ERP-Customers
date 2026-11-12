import { useEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { AlertTriangle, ArrowLeft, Camera, Check, Clock, Flashlight, FlashlightOff, ImagePlus, Images, LoaderCircle, LockKeyhole, LogOut, RefreshCw, ScanBarcode, Search, ShieldCheck, Trash2, X, ZoomIn } from "lucide-react";
import { Html5Qrcode, Html5QrcodeSupportedFormats } from "html5-qrcode";
import { BarcodeFormat, BinaryBitmap, DecodeHintType, GlobalHistogramBinarizer, HybridBinarizer, MultiFormatReader, RGBLuminanceSource } from "@zxing/library";
import "./styles.css";
type ImageProcessingStatus="pending"|"processing"|"completed"|"failed";
type Photo={id:string;url:string;status?:ImageProcessingStatus;jobId?:string|null;error?:string|null;errorCode?:string|null;updatedAt?:string|null};
type QueueStatus={enabled?:boolean;paused:boolean;requiresReauth:boolean;pauseReason:string|null;counts?:Record<string,number>};
type Product={id:string;unitId:string;code:string;kind?:string;name:string;category:string;description:string;unit:string;price:number|null;images:Photo[]};
type Session={authenticated:boolean;username:string|null};
async function request(path:string,method="GET",body?:unknown,signal?:AbortSignal) {
  const form=body instanceof FormData;
  const response=await fetch(`/api${path}`,{method,signal,credentials:"same-origin",headers:{"X-Emoji-Request":"1",...(!form && body?{"Content-Type":"application/json"}:{})},body:body?(form?body:JSON.stringify(body)):undefined});
  const value=await response.json();
  if(!response.ok) throw new Error(value.error??"تعذر تنفيذ الطلب");
  return value;
}
const money=(value:number)=>value.toLocaleString("ar-EG-u-nu-latn",{maximumFractionDigits:2});
function App() {
  const manage=location.pathname==="/manage";
  const [session,setSession]=useState<Session>({authenticated:false,username:null});
  const [code,setCode]=useState(""),[searched,setSearched]=useState("");
  const [products,setProducts]=useState<Product[]>([]),[selected,setSelected]=useState(0),[activeImage,setActiveImage]=useState(0);
  const [busy,setBusy]=useState(false),[mutating,setMutating]=useState(false),[error,setError]=useState(""),[success,setSuccess]=useState("");
  const [username,setUsername]=useState(""),[password,setPassword]=useState(""),[logging,setLogging]=useState(false),[sessionLoading,setSessionLoading]=useState(manage);
  const [truncated,setTruncated]=useState(false),[deleteId,setDeleteId]=useState<string|null>(null),[zoom,setZoom]=useState(false);
  const [suggestions,setSuggestions]=useState<Product[]>([]),[suggestionsOpen,setSuggestionsOpen]=useState(false),[suggesting,setSuggesting]=useState(false);
  const [activeSuggestion,setActiveSuggestion]=useState(-1),[suggestionError,setSuggestionError]=useState("");
  const [scannerOpen,setScannerOpen]=useState(false),[torchActive,setTorchActive]=useState(false),[hasTorch,setHasTorch]=useState(false),[cameraError,setCameraError]=useState(""),[cameraErrorKind,setCameraErrorKind]=useState<"insecure"|"permission"|"other"|"">(""),[scanningFile,setScanningFile]=useState(false),[scanModalError,setScanModalError]=useState(""),[capturedPreview,setCapturedPreview]=useState<string|null>(null),[queueStatus,setQueueStatus]=useState<QueueStatus|null>(null);
  const searchInput=useRef<HTMLInputElement>(null),sequence=useRef(0),dialog=useRef<HTMLDialogElement>(null),zoomDialog=useRef<HTMLDialogElement>(null),scannerDialog=useRef<HTMLDialogElement>(null),scannerRef=useRef<Html5Qrcode|null>(null),scannerBackdropDown=useRef(false),hdSamplerRef=useRef<number|null>(null),scannerRetryRef=useRef<(() => void)|null>(null);

  const PORTAL_BARCODE_FORMATS = [
    BarcodeFormat.CODE_128,
    BarcodeFormat.CODE_93,
    BarcodeFormat.CODE_39,
    BarcodeFormat.EAN_13,
    BarcodeFormat.EAN_8,
    BarcodeFormat.UPC_A,
    BarcodeFormat.UPC_E,
    BarcodeFormat.QR_CODE,
    BarcodeFormat.ITF,
  ];

  function createZxBarcodeReader(): MultiFormatReader {
    const hints = new Map();
    hints.set(DecodeHintType.TRY_HARDER, true);
    hints.set(DecodeHintType.POSSIBLE_FORMATS, PORTAL_BARCODE_FORMATS);
    const reader = new MultiFormatReader();
    reader.setHints(hints);
    return reader;
  }

  function rgbaToLuminances(rgba: Uint8ClampedArray, len: number, enhanceContrast = false): Uint8ClampedArray {
    const lum = new Uint8ClampedArray(len);
    const hist = enhanceContrast ? new Uint32Array(256) : null;
    for (let i = 0; i < len; i++) {
      const p = i * 4;
      const y = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
      lum[i] = y;
      if (hist) hist[y]++;
    }
    if (!hist || len === 0) return lum;
    const clip = Math.max(1, Math.floor(len * 0.01));
    let acc = 0;
    let lo = 0;
    while (lo < 255 && acc + hist[lo] <= clip) { acc += hist[lo++]; }
    acc = 0;
    let hi = 255;
    while (hi > lo && acc + hist[hi] <= clip) { acc += hist[hi--]; }
    const span = hi - lo;
    if (span >= 16) {
      const scale = 255 / span;
      for (let i = 0; i < len; i++) {
        const v = (lum[i] - lo) * scale;
        lum[i] = v <= 0 ? 0 : v >= 255 ? 255 : v | 0;
      }
    }
    return lum;
  }

  function rotateLuminance90(src: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
    const dst = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) {
      const rowOffset = y * w;
      const destCol = h - 1 - y;
      for (let x = 0; x < w; x++) {
        dst[x * h + destCol] = src[rowOffset + x];
      }
    }
    return dst;
  }

  function decodeLuminanceMatrix(reader: MultiFormatReader, luminances: Uint8ClampedArray, width: number, height: number): string | null {
    const source = new RGBLuminanceSource(luminances, width, height);
    for (const Binarizer of [HybridBinarizer, GlobalHistogramBinarizer]) {
      try {
        const res = reader.decode(new BinaryBitmap(new Binarizer(source)));
        if (res?.getText()) return res.getText();
      } catch {}
    }
    return null;
  }

  function clearHdSampler() {
    if (hdSamplerRef.current !== null) {
      window.clearInterval(hdSamplerRef.current);
      hdSamplerRef.current = null;
    }
  }

  useEffect(() => () => { clearHdSampler(); }, [scannerOpen]);
  const product=products[selected];
  const activePhoto=product?.images[activeImage];
  const hasActiveProcessing=Boolean(product?.images.some(img=>img.status==="pending"||img.status==="processing"));
  const activeProcessingSignature=product?.images.filter(img=>img.status==="pending"||img.status==="processing").map(img=>`${img.id}:${img.status}:${img.url}`).join("|")||"";
  useEffect(()=>{void request("/session").then(setSession).catch(e=>{if(manage)setError(e.message);}).finally(()=>setSessionLoading(false));},[manage]);
  useEffect(()=>{setActiveImage(0);},[selected]);
  useEffect(()=>{
    if(!manage||!session.authenticated){setQueueStatus(null);return;}
    let cancelled=false,refreshing=false;
    const controller=new AbortController();
    const refresh=async()=>{
      if(refreshing||cancelled)return;
      refreshing=true;
      try{
        const data=await request("/image-jobs/status","GET",undefined,controller.signal);
        if(!cancelled)setQueueStatus(data);
      }catch{}finally{refreshing=false;}
    };
    void refresh();
    const timer=window.setInterval(()=>{void refresh();},5000);
    window.addEventListener("focus",refresh);
    return()=>{cancelled=true;controller.abort();window.clearInterval(timer);window.removeEventListener("focus",refresh);};
  },[manage,session.authenticated]);
  useEffect(()=>{
    if(!product||!hasActiveProcessing)return;
    let cancelled=false;
    const targetId=product.id,targetUnitId=product.unitId,key=`${targetId}:${targetUnitId}`;
    let prevById=new Map(product.images.map(img=>[img.id,img]));
    const poll=async()=>{
      try{
        const data=await request(`/products/${encodeURIComponent(targetId)}/${encodeURIComponent(targetUnitId)}`);
        const fresh=(data.products||[])[0] as Product|undefined;
        if(cancelled||!fresh)return;
        const completedAny=fresh.images.some(img=>{
          const prev=prevById.get(img.id);
          return prev&&(prev.status==="pending"||prev.status==="processing")&&img.status==="completed";
        });
        prevById=new Map(fresh.images.map(img=>[img.id,img]));
        setProducts(current=>current.map(p=>`${p.id}:${p.unitId}`===key?{...p,images:fresh.images}:p));
        if(completedAny)setSuccess("تمت معالجة الصورة وتحديثها تلقائيًا");
      }catch{}
    };
    const intervalMs=queueStatus?.paused?6000:2500;
    const timer=window.setInterval(()=>{void poll();},intervalMs);
    return()=>{cancelled=true;window.clearInterval(timer);};
  },[product?.id,product?.unitId,hasActiveProcessing,activeProcessingSignature,manage,session.authenticated,queueStatus?.paused]);
  useEffect(()=>{if(deleteId)dialog.current?.showModal();else dialog.current?.close();},[deleteId]);
  useEffect(()=>{if(zoom)zoomDialog.current?.showModal();else zoomDialog.current?.close();},[zoom]);
  useEffect(()=>{if(scannerOpen)scannerDialog.current?.showModal();else scannerDialog.current?.close();},[scannerOpen]);
  useEffect(()=>{return ()=>{if(capturedPreview)URL.revokeObjectURL(capturedPreview);};},[capturedPreview]);
  useEffect(()=>{if(activeSuggestion>=0)document.getElementById(`model-suggestion-${activeSuggestion}`)?.scrollIntoView({block:"nearest"});},[activeSuggestion]);
  useEffect(()=>{
    const clean=code.trim().replace(/\s+/g," ");
    if(!suggestionsOpen || !clean || mutating || (manage && !session.authenticated)) {
      setSuggestions([]);setSuggesting(false);return;
    }
    if(!/^[A-Za-z0-9 _\-]+$/.test(clean) || !/[A-Za-z0-9]/.test(clean)) {
      setSuggestions([]);setSuggesting(false);setSuggestionError("اكتب حروف إنجليزية وأرقام فقط (مسموح بالمسافات أو -).");return;
    }
    const controller=new AbortController();let current=true;
    setSuggesting(true);setSuggestionError("");
    const timer=setTimeout(()=>{
      void request(`/suggestions?code=${encodeURIComponent(clean)}`,"GET",undefined,controller.signal)
        .then(result=>{if(current){setSuggestions(result.suggestions);setActiveSuggestion(-1);}})
        .catch(e=>{if(current && e.name!=="AbortError")setSuggestionError(e.message);})
        .finally(()=>{if(current)setSuggesting(false);});
    },250);
    return ()=>{current=false;clearTimeout(timer);controller.abort();};
  },[code,suggestionsOpen,mutating,manage,session.authenticated]);
  function editCode(value:string){
    searchInput.current?.setCustomValidity("");
    setCode(value.replace(/^\s+/,"").replace(/\s{2,}/g," "));
    setSuggestions([]);setActiveSuggestion(-1);setSuggestionsOpen(true);
  }
  function dismissSearchInput(){
    searchInput.current?.blur();
    if(document.activeElement instanceof HTMLElement && document.activeElement!==document.body){
      document.activeElement.blur();
    }
  }
  function clearSearch(){
    searchInput.current?.setCustomValidity("");
    setCode("");setSuggestions([]);setActiveSuggestion(-1);setSuggestionsOpen(false);setSuggestionError("");
    searchInput.current?.focus();
  }
  async function runSearch(value:string,choice?:Product) {
    const clean=value.trim().replace(/\s+/g," ");
    if(mutating || !clean)return;
    dismissSearchInput();
    setSuggestionsOpen(false);setSuggestions([]);setActiveSuggestion(-1);setSuggestionError("");
    if(typeof window!=="undefined" && window.innerWidth<=600 && window.scrollY>36) {
      window.scrollTo({top:0,behavior:"smooth"});
    }
    const current=++sequence.current;setBusy(true);setError("");setSuccess("");setProducts([]);setSelected(0);setActiveImage(0);setSearched("");
    try {
      const path=choice?`/products/${choice.id}/${choice.unitId}`:`/products?code=${encodeURIComponent(clean)}`;
      const result=await request(path);
      if(current===sequence.current){setProducts(result.products);setTruncated(result.truncated);setSearched(choice?choice.code:clean);}
    }
    catch(e){if(current===sequence.current)setError((e as Error).message);}
    finally{if(current===sequence.current)setBusy(false);}
  }
  function chooseSuggestion(choice:Product){searchInput.current?.setCustomValidity("");setCode(choice.code);void runSearch(choice.code,choice);}
  async function search(e:FormEvent) {
    e.preventDefault();await runSearch(code);
  }
  function playBeep() {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        gain.gain.setValueAtTime(0.2, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.15);
      }
    } catch {}
    try { if (navigator.vibrate) navigator.vibrate(80); } catch {}
  }
  function cleanBarcodeText(raw: string): string {
    return raw.trim().replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  }
  function onBarcodeScanned(text: string) {
    const clean = cleanBarcodeText(text);
    if (!clean) return;
    playBeep();
    setScannerOpen(false);
    setCapturedPreview(null);
    setScanModalError("");
    setCode(clean);
    void runSearch(clean);
  }
  const toggleTorch = async () => {
    try {
      if (!scannerRef.current) return;
      const next = !torchActive;
      await scannerRef.current.applyVideoConstraints({ advanced: [{ torch: next } as any] });
      setTorchActive(next);
    } catch (e) {
      console.warn("Torch failed:", e);
    }
  };
  async function decodeBarcodeFromFile(file: File): Promise<string> {
    // Strategy 1: Fast native BarcodeDetector API (Built into Chrome on Android)
    if (typeof (window as any).BarcodeDetector !== "undefined") {
      try {
        const detector = new (window as any).BarcodeDetector({
          formats: [
            "code_128",
            "code_39",
            "code_93",
            "ean_13",
            "ean_8",
            "upc_a",
            "upc_e",
            "qr_code",
            "itf",
          ],
        });
        if (typeof createImageBitmap === "function") {
          const bitmap = await createImageBitmap(file);
          try {
            const detected = await detector.detect(bitmap);
            if (detected && detected.length > 0 && detected[0].rawValue) {
              return detected[0].rawValue;
            }
          } finally {
            bitmap.close();
          }
        }
      } catch (e) {
        console.warn("Native BarcodeDetector pass failed, trying ZXing fallback:", e);
      }
    }

    // Strategy 2: ZXing MultiFormatReader with multi-angle and dual binarizers
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      const cleanup = () => {
        try { URL.revokeObjectURL(url); } catch {}
      };

      img.onload = () => {
        try {
          const naturalW = img.naturalWidth || img.width;
          const naturalH = img.naturalHeight || img.height;
          if (!naturalW || !naturalH) {
            cleanup();
            return reject(new Error("IMAGE_DIMENSIONS_INVALID"));
          }

          const hints = new Map();
          hints.set(DecodeHintType.TRY_HARDER, true);
          hints.set(DecodeHintType.POSSIBLE_FORMATS, PORTAL_BARCODE_FORMATS);

          const reader = new MultiFormatReader();
          reader.setHints(hints);

          const tryDecodeCanvas = (cvs: HTMLCanvasElement): string | null => {
            try {
              const ctx = cvs.getContext("2d", { willReadFrequently: true });
              if (!ctx) return null;
              const { width, height } = cvs;
              const { data } = ctx.getImageData(0, 0, width, height);
              const len = width * height;
              const luminances = new Uint8ClampedArray(len);
              for (let i = 0; i < len; i++) {
                luminances[i] = (data[i * 4] * 77 + data[i * 4 + 1] * 150 + data[i * 4 + 2] * 29) >> 8;
              }
              const source = new RGBLuminanceSource(luminances, width, height);

              // 1. Try Hybrid Binarizer
              try {
                const res = reader.decode(new BinaryBitmap(new HybridBinarizer(source)));
                if (res && res.getText()) return res.getText();
              } catch {}

              // 2. Try Global Histogram Binarizer (superior on stickers with glare)
              try {
                const res = reader.decode(new BinaryBitmap(new GlobalHistogramBinarizer(source)));
                if (res && res.getText()) return res.getText();
              } catch {}
            } catch {}
            return null;
          };

          const maxDim = 1400;
          let scaledW = naturalW;
          let scaledH = naturalH;
          if (scaledW > maxDim || scaledH > maxDim) {
            if (scaledW > scaledH) {
              scaledH = Math.round((scaledH * maxDim) / scaledW);
              scaledW = maxDim;
            } else {
              scaledW = Math.round((scaledW * maxDim) / scaledH);
              scaledH = maxDim;
            }
          }

          // Pass 1: Standard 0° orientation
          const c0 = document.createElement("canvas");
          c0.width = scaledW;
          c0.height = scaledH;
          const ctx0 = c0.getContext("2d");
          if (ctx0) {
            ctx0.imageSmoothingEnabled = true;
            ctx0.imageSmoothingQuality = "high";
            ctx0.drawImage(img, 0, 0, scaledW, scaledH);
            const res0 = tryDecodeCanvas(c0);
            if (res0) { cleanup(); return resolve(res0); }
          }

          // Pass 2: Rotated 90° orientation (standard for portrait mobile photos)
          const c90 = document.createElement("canvas");
          c90.width = scaledH;
          c90.height = scaledW;
          const ctx90 = c90.getContext("2d");
          if (ctx90) {
            ctx90.imageSmoothingEnabled = true;
            ctx90.imageSmoothingQuality = "high";
            ctx90.translate(scaledH / 2, scaledW / 2);
            ctx90.rotate((90 * Math.PI) / 180);
            ctx90.drawImage(img, -scaledW / 2, -scaledH / 2, scaledW, scaledH);
            const res90 = tryDecodeCanvas(c90);
            if (res90) { cleanup(); return resolve(res90); }
          }

          // Pass 3: Rotated 270° orientation
          const c270 = document.createElement("canvas");
          c270.width = scaledH;
          c270.height = scaledW;
          const ctx270 = c270.getContext("2d");
          if (ctx270) {
            ctx270.imageSmoothingEnabled = true;
            ctx270.imageSmoothingQuality = "high";
            ctx270.translate(scaledH / 2, scaledW / 2);
            ctx270.rotate((270 * Math.PI) / 180);
            ctx270.drawImage(img, -scaledW / 2, -scaledH / 2, scaledW, scaledH);
            const res270 = tryDecodeCanvas(c270);
            if (res270) { cleanup(); return resolve(res270); }
          }

          // Pass 4: High-resolution center crops (supports iPhone ~15cm min focus & glare)
          const fileReader = createZxBarcodeReader();
          const tryRegion = (rx: number, ry: number, enhanceContrast: boolean): string | null => {
            const cropW = Math.max(1, Math.round(naturalW * rx));
            const cropH = Math.max(1, Math.round(naturalH * ry));
            const startX = Math.round((naturalW - cropW) / 2);
            const startY = Math.round((naturalH - cropH) / 2);
            const longest = Math.max(cropW, cropH);
            const scale = longest > 1400 ? 1400 / longest : longest < 750 ? Math.min(2, 960 / longest) : 1;
            const outW = Math.max(1, Math.round(cropW * scale));
            const outH = Math.max(1, Math.round(cropH * scale));

            const cCrop = document.createElement("canvas");
            cCrop.width = outW;
            cCrop.height = outH;
            const ctxCrop = cCrop.getContext("2d", { willReadFrequently: true });
            if (!ctxCrop) return null;
            ctxCrop.drawImage(img, startX, startY, cropW, cropH, 0, 0, outW, outH);

            if (!enhanceContrast) {
              const direct = tryDecodeCanvas(cCrop);
              if (direct) return direct;
            }

            const imgData = ctxCrop.getImageData(0, 0, outW, outH);
            const lums = rgbaToLuminances(imgData.data, outW * outH, enhanceContrast);
            const decoded = decodeLuminanceMatrix(fileReader, lums, outW, outH);
            if (decoded) return decoded;
            return decodeLuminanceMatrix(fileReader, rotateLuminance90(lums, outW, outH), outH, outW);
          };

          for (const [rx, ry, enhance] of [
            [0.7, 0.6, false],
            [0.5, 0.38, false],
            [0.5, 0.38, true],
            [0.7, 0.6, true],
          ] as const) {
            const hit = tryRegion(rx, ry, enhance);
            if (hit) { cleanup(); return resolve(hit); }
          }

          cleanup();
          reject(new Error("NOT_FOUND"));
        } catch (err) {
          cleanup();
          reject(err);
        }
      };

      img.onerror = () => {
        cleanup();
        reject(new Error("IMAGE_LOAD_FAILED"));
      };

      img.src = url;
    });
  }
  async function handleScanFile(file: File) {
    const previewUrl = URL.createObjectURL(file);
    setCapturedPreview(previewUrl);
    setScanningFile(true);
    setScanModalError("");

    try {
      // 1. Parallel: Try server-side barcode decoder
      const tryServer = async (): Promise<string | null> => {
        try {
          const opt = await optimizeImageForUpload(file);
          const form = new FormData();
          form.append("image", opt);
          const res = await request("/decode-barcode", "POST", form);
          return res.code ? String(res.code) : null;
        } catch {
          return null;
        }
      };

      // 2. Parallel: Try client-side ZXing decoder
      const tryClient = async (): Promise<string | null> => {
        try {
          return await decodeBarcodeFromFile(file);
        } catch {
          return null;
        }
      };

      const [serverCode, clientCode] = await Promise.all([tryServer(), tryClient()]);
      const code = serverCode || clientCode;

      if (code) {
        onBarcodeScanned(code);
      } else {
        setScanModalError("لم يتم التعرف على باركود واضح في الصورة؛ تأكد من وضوح الخطوط الرأسية للباركود وقرّب الكاميرا أكثر على التيكت.");
      }
    } catch {
      setScanModalError("لم يتم التعرف على باركود واضح في الصورة؛ تأكد من وضوح الخطوط الرأسية للباركود وقرّب الكاميرا أكثر على التيكت.");
    } finally {
      setScanningFile(false);
    }
  }
  useEffect(() => {
    if (!scannerOpen) {
      setTorchActive(false);
      setHasTorch(false);
      setCameraError("");
      setScanModalError("");
      setCapturedPreview(null);
      return;
    }
    let active = true;
    let html5QrCode: Html5Qrcode | null = null;
    const startHdVideoSampler = (scanner: Html5Qrcode) => {
      clearHdSampler();
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      const reader = createZxBarcodeReader();
      let tick = 0;

      hdSamplerRef.current = window.setInterval(() => {
        if (!active || scannerRef.current !== scanner) {
          clearHdSampler();
          return;
        }
        const video = document.querySelector("#portal-barcode-scanner video") as HTMLVideoElement | null;
        if (!video || video.readyState < 2 || video.videoWidth < 320 || video.videoHeight < 240) return;

        const vw = video.videoWidth;
        const vh = video.videoHeight;
        const cw = video.clientWidth || vw;
        const ch = video.clientHeight || vh;
        const coverScale = Math.max(cw / vw, ch / vh);
        const visW = Math.min(vw, Math.round(cw / coverScale));
        const visH = Math.min(vh, Math.round(ch / coverScale));
        const cropW = Math.max(240, Math.round(visW * 0.88));
        const cropH = Math.max(140, Math.round(visH * 0.6));
        const sx = Math.max(0, Math.floor((vw - cropW) / 2));
        const sy = Math.max(0, Math.floor((vh - cropH) / 2));

        const scale = Math.max(cropW, cropH) > 1280 ? 1280 / Math.max(cropW, cropH) : 1;
        const dw = Math.max(1, Math.round(cropW * scale));
        const dh = Math.max(1, Math.round(cropH * scale));
        if (canvas.width !== dw) canvas.width = dw;
        if (canvas.height !== dh) canvas.height = dh;

        ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, dw, dh);
        const imgData = ctx.getImageData(0, 0, dw, dh);
        const currentTick = tick++;
        const lums = rgbaToLuminances(imgData.data, dw * dh, currentTick % 2 === 1);
        let decoded = decodeLuminanceMatrix(reader, lums, dw, dh);
        if (!decoded && currentTick % 3 === 2) {
          decoded = decodeLuminanceMatrix(reader, rotateLuminance90(lums, dw, dh), dh, dw);
        }
        if (decoded && active) {
          active = false;
          clearHdSampler();
          onBarcodeScanned(decoded);
        }
      }, 420);
    };

    const startScanner = async () => {
      clearHdSampler();
      setCameraError("");
      setCameraErrorKind("");
      setScanModalError("");
      setHasTorch(false);
      setTorchActive(false);

      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        if (!active) return;
        const insecure = typeof window !== "undefined" && !window.isSecureContext;
        setCameraErrorKind(insecure ? "insecure" : "other");
        setCameraError(insecure
          ? "الكاميرا المباشرة تحتاج اتصال HTTPS آمن."
          : "المتصفح الحالي لا يدعم تشغيل الكاميرا المباشرة.");
        return;
      }

      try {
        html5QrCode = new Html5Qrcode("portal-barcode-scanner", {
          formatsToSupport: [
            Html5QrcodeSupportedFormats.CODE_128,
            Html5QrcodeSupportedFormats.EAN_13,
            Html5QrcodeSupportedFormats.EAN_8,
            Html5QrcodeSupportedFormats.CODE_39,
            Html5QrcodeSupportedFormats.CODE_93,
            Html5QrcodeSupportedFormats.UPC_A,
            Html5QrcodeSupportedFormats.UPC_E,
            Html5QrcodeSupportedFormats.QR_CODE,
            Html5QrcodeSupportedFormats.ITF,
          ],
          experimentalFeatures: { useBarCodeDetectorIfSupported: true },
          verbose: false,
        });
        scannerRef.current = html5QrCode;

        const hasNativeDetector = typeof window !== "undefined" && "BarcodeDetector" in window;
        const baseConfig = {
          fps: hasNativeDetector ? 15 : 8,
          disableFlip: true,
          qrbox: (w: number, h: number) => ({
            width: Math.max(200, Math.floor(w * 0.9)),
            height: Math.max(120, Math.floor(h * 0.56)),
          }),
        };

        const onDecoded = (decodedText: string) => {
          if (!active) return;
          active = false;
          clearHdSampler();
          onBarcodeScanned(decodedText);
        };

        try {
          await html5QrCode.start(
            { facingMode: "environment" },
            {
              ...baseConfig,
              videoConstraints: {
                facingMode: { ideal: "environment" },
                width: { ideal: 1920 },
                height: { ideal: 1080 },
              },
            },
            onDecoded,
            () => {}
          );
        } catch (hdErr: any) {
          const hdMsg = String(hdErr?.name || hdErr?.message || hdErr || "");
          if (/NotAllowed|Permission/i.test(hdMsg)) throw hdErr;
          await html5QrCode.start(
            { facingMode: "environment" },
            baseConfig,
            onDecoded,
            () => {}
          );
        }

        if (!active) return;
        try {
          await html5QrCode.applyVideoConstraints({
            advanced: [{ focusMode: "continuous" } as any],
          });
        } catch {}

        try {
          const cap = html5QrCode.getRunningTrackCameraCapabilities();
          if (cap && cap.torchFeature && cap.torchFeature().isSupported()) {
            setHasTorch(true);
          }
        } catch {}

        startHdVideoSampler(html5QrCode);
      } catch (err: any) {
        if (!active) return;
        clearHdSampler();
        const rawMsg = String(err?.name || err?.message || err || "");
        const insecure = typeof window !== "undefined" && !window.isSecureContext;
        if (insecure) {
          setCameraErrorKind("insecure");
          setCameraError("الكاميرا المباشرة تحتاج اتصال HTTPS آمن.");
        } else if (/NotAllowed|Permission/i.test(rawMsg)) {
          setCameraErrorKind("permission");
          setCameraError("تم رفض إذن الكاميرا؛ اسمح للمتصفح بالكاميرا ثم أعد المحاولة.");
        } else {
          setCameraErrorKind("other");
          setCameraError(err?.message || "تعذر فتح الكاميرا المباشرة؛ يمكنك إعادة المحاولة أو تصوير الباركود.");
        }
      }
    };
    scannerRetryRef.current = () => {
      if (!active) return;
      void startScanner();
    };
    const t = setTimeout(() => { void startScanner(); }, 80);
    return () => {
      active = false;
      clearTimeout(t);
      if (scannerRef.current) {
        if (scannerRef.current.isScanning) {
          void scannerRef.current.stop().then(() => {
            scannerRef.current?.clear();
            scannerRef.current = null;
          }).catch(() => {});
        } else {
          try { scannerRef.current.clear(); } catch {}
          scannerRef.current = null;
        }
      }
    };
  }, [scannerOpen]);
  async function login(e:FormEvent) {
    e.preventDefault();setLogging(true);setError("");
    try{await request("/login","POST",{username,password});setPassword("");setSession(await request("/session"));}
    catch(e){setError((e as Error).message);}finally{setLogging(false);}
  }
  async function logout(){try{await request("/logout","POST");setSession({authenticated:false,username:null});setQueueStatus(null);setSuccess("");}catch(e){setError((e as Error).message);}}
  async function optimizeImageForUpload(file: File): Promise<File> {
    if (file.size <= 4 * 1024 * 1024 && ["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      return file;
    }
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const maxDim = 2000;
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) { resolve(file); return; }
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            if (!blob) { resolve(file); return; }
            const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
            resolve(new File([blob], name, { type: "image/jpeg" }));
          },
          "image/jpeg",
          0.88
        );
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(file);
      };
      img.src = url;
    });
  }
  async function upload(file:File) {
    if(!product || mutating)return;
    setMutating(true);setError("");setSuccess("");
    try{
      const readyFile = await optimizeImageForUpload(file);
      if(readyFile.size > 5 * 1024 * 1024){setError("الحد الأقصى للصورة 5 ميجابايت");return;}
      const key=`${product.id}:${product.unitId}`;
      const form=new FormData();form.append("image",readyFile);
      const result=await request(`/products/${product.id}/${product.unitId}/images`,"POST",form);
      setProducts(current=>current.map(p=>`${p.id}:${p.unitId}`===key?{...p,images:result.images}:p));
      setActiveImage(result.images.length-1);setSuccess("تمت إضافة الصورة؛ جاري معالجتها في الخلفية");
      void request("/image-jobs/status").then(setQueueStatus).catch(()=>{});
    }catch(e){setError((e as Error).message);}finally{setMutating(false);}
  }
  async function replaceImage(imageId:string,file:File){
    if(!product || mutating)return;
    setMutating(true);setError("");setSuccess("");
    try{
      const readyFile=await optimizeImageForUpload(file);
      if(readyFile.size > 5 * 1024 * 1024){setError("الحد الأقصى للصورة 5 ميجابايت");return;}
      const key=`${product.id}:${product.unitId}`;
      const form=new FormData();form.append("image",readyFile);
      const result=await request(`/images/${imageId}`,"PUT",form);
      setProducts(current=>current.map(p=>`${p.id}:${p.unitId}`===key?{...p,images:result.images}:p));
      setSuccess("تم استبدال الصورة؛ جاري معالجتها في الخلفية");
      void request("/image-jobs/status").then(setQueueStatus).catch(()=>{});
    }catch(e){setError((e as Error).message);}finally{setMutating(false);}
  }
  async function retryImage(imageId:string){
    if(!product || mutating)return;
    setMutating(true);setError("");setSuccess("");
    try{
      const key=`${product.id}:${product.unitId}`;
      const result=await request(`/images/${imageId}/retry`,"POST");
      setProducts(current=>current.map(p=>`${p.id}:${p.unitId}`===key?{...p,images:result.images}:p));
      setSuccess("تمت إعادة جدولة معالجة الصورة");
      void request("/image-jobs/status").then(setQueueStatus).catch(()=>{});
    }catch(e){setError((e as Error).message);}finally{setMutating(false);}
  }
  async function remove(){if(!deleteId)return;setMutating(true);setError("");setSuccess("");
    try{await request(`/images/${deleteId}`,"DELETE");setProducts(current=>current.map(p=>({...p,images:p.images.filter(i=>i.id!==deleteId)})));setActiveImage(0);setSuccess("تم حذف الصورة");}
    catch(e){setError((e as Error).message);}finally{setDeleteId(null);setMutating(false);}}
  const mobileCompact=Boolean(searched || busy || error) && (!manage || session.authenticated);
  return <div className={`portal${mobileCompact?" mobile-compact":""}`}>
    <header className="topbar"><a className="brand" href="/" aria-label="إيموجي ستور — الاستعلام"><img src="/emoji-logo.png" alt="EMOJI STORE"/><span className="brand-divider"/><span>دليل الموديلات<span className="brand-sub">EMOJI STORE CATALOG</span></span></a>
      <nav>{manage?<a href="/">الاستعلام <ArrowLeft size={16}/></a>:<a href="/manage"><LockKeyhole size={15}/> إدارة الصور</a>}{manage && session.authenticated && <button className="nav-logout" onClick={logout} disabled={mutating}><LogOut size={16}/> خروج</button>}</nav></header>
    <main>
      <section className="hero"><div className="hero-copy"><div className="hero-intro"><div className="eyebrow"><span/> {manage?"مساحة إدارة الصور":"كل موديل، في مكان واحد"}</div><h1>{manage?<>صورة أوضح.<br/><span>للموديل الصح.</span></>:<>الموديل اللي بتدور عليه،<br/><span>تفاصيله هنا.</span></>}</h1><p>{manage?"ابحث عن الموديل وأضف صوره ليشاهدها فريق الفروع.":"اكتب كود الموديل أو رقم الصنف، واعرف سعره وتفاصيله وصوره."}</p></div>
        {(!manage || session.authenticated) && <search className="search-wrap"><form className={`search-form${suggestionsOpen && code.trim()?" suggestions-open":""}`} onSubmit={search} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))setSuggestionsOpen(false);}}>
          <label htmlFor="model-code">كود الموديل أو رقم الصنف</label>
          <div className="search-input-wrap"><div className="search-control"><Search size={23}/>
            <input id="model-code" name="code" ref={searchInput} type="text" dir="ltr" value={code} onChange={e=>editCode(e.target.value)} onFocus={()=>setSuggestionsOpen(true)} placeholder="V 6302" autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} enterKeyHint="search" maxLength={100} pattern="[ ]*[A-Za-z0-9_\-][A-Za-z0-9 _\-]*" title="حروف إنجليزية وأرقام فقط (مسموح بالمسافات أو -)، مثال: V 6302" required disabled={mutating}
              onInvalid={e=>{const el=e.currentTarget;el.setCustomValidity(el.validity.valueMissing?"اكتب كود الموديل أو رقم الصنف أولًا.":"استخدم حروف إنجليزية وأرقام فقط (مسموح بالمسافات أو -)، مثال: V 6302");}}
              role="combobox" aria-autocomplete="list" aria-expanded={suggestionsOpen && Boolean(code.trim())} aria-controls="model-suggestions" aria-activedescendant={suggestionsOpen && activeSuggestion>=0?`model-suggestion-${activeSuggestion}`:undefined}
              onKeyDown={e=>{
                if(e.nativeEvent.isComposing)return;
                if(e.key==="Escape"){e.preventDefault();setSuggestionsOpen(false);setActiveSuggestion(-1);}
                if(e.key==="ArrowDown" || e.key==="ArrowUp"){e.preventDefault();setSuggestionsOpen(true);if(suggestions.length)setActiveSuggestion(i=>e.key==="ArrowDown"?(i+1)%suggestions.length:(i<=0?suggestions.length-1:i-1));}
                if(e.key==="Enter" && suggestionsOpen && activeSuggestion>=0 && suggestions[activeSuggestion]){e.preventDefault();chooseSuggestion(suggestions[activeSuggestion]);}
              }}/>
            {code && !busy && !mutating && <button type="button" className="search-clear-btn" onClick={clearSearch} title="مسح البحث" aria-label="مسح البحث"><X size={16}/></button>}
            <button type="button" className="barcode-scan-btn" onClick={()=>setScannerOpen(true)} title="مسح باركود الصنف بالكاميرا" aria-label="مسح باركود الصنف بالكاميرا"><ScanBarcode size={21}/></button>
            <button type="submit" className="search-submit-btn" disabled={busy||mutating}>{busy?<LoaderCircle className="spin" size={20}/>:<>ابحث <ArrowLeft size={18}/></>}</button>
          </div>
          {suggestionsOpen && code.trim() && <div className="suggestion-panel"><div className="suggestion-title">اقتراحات كود الموديل</div>
            <div role="listbox" id="model-suggestions" aria-label="اقتراحات كود الموديل" aria-busy={suggesting}>
              {suggestions.map((p,i)=><button type="button" role="option" tabIndex={-1} aria-selected={activeSuggestion===i} id={`model-suggestion-${i}`} className="model-suggestion" key={`${p.id}:${p.unitId}`} onMouseDown={e=>e.preventDefault()} onClick={()=>chooseSuggestion(p)}><strong dir="ltr">{p.code}</strong><span>{p.description||p.name}<small>{p.unit} · رقم الصنف <bdi>{p.id}</bdi></small></span><ArrowLeft size={16}/></button>)}
            </div>
            {suggesting?<p className="suggestion-status" role="status">جاري تحميل الاقتراحات…</p>:suggestionError?<p className="suggestion-status" role="status">{suggestionError}</p>:!suggestions.length?<p className="suggestion-status" role="status">مفيش كود موديل مطابق. لو بتبحث برقم الصنف، اكتبه كامل واضغط ابحث.</p>:null}
          </div>}
          </div><div className="search-hint">اكتب جزء من كود الموديل واختار من الاقتراحات، أو اكتب رقم الصنف كامل واضغط ابحث.</div>
        </form></search>}
        {manage && session.authenticated && <div className="signed-in"><ShieldCheck size={16}/> مسجّل باسم {session.username}</div>}
      </div><div className="hero-art" aria-hidden="true"><div className="art-ring"/><img src="/emoji-logo.png"/><span className="art-caption">FIND YOUR NEXT FAVORITE.</span><span className="art-tag">THE EMOJI EDIT</span></div></section>
      <div className="content">
        {error && <div role="alert" className="notice error"><span>{error}</span><button onClick={()=>setError("")} aria-label="إغلاق التنبيه"><X size={18}/></button></div>}
        {success && <div role="status" className="notice success"><Check size={18}/>{success}</div>}
        {manage && !session.authenticated ? (
          <section className="login-panel">
            <h2>دخول مسؤول</h2>
            <p>استخدم بيانات الدخول التي حددها مسؤول النظام.</p>
            {sessionLoading ? (
              <LoaderCircle className="spin" />
            ) : (
              <form onSubmit={login} className="login-form">
                <div className="login-field">
                  <label htmlFor="login-username">اسم المستخدم</label>
                  <input
                    id="login-username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                    required
                    maxLength={80}
                    dir="auto"
                  />
                </div>
                <div className="login-field">
                  <label htmlFor="login-password">كلمة المرور</label>
                  <input
                    id="login-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                    maxLength={200}
                  />
                </div>
                <button className="primary login-submit" disabled={logging}>
                  {logging ? <LoaderCircle className="spin" size={18} /> : "تسجيل الدخول"}
                </button>
              </form>
            )}
            <a href="/" className="login-back-link">
              <span>العودة للاستعلام بدون حساب</span>
              <ArrowLeft size={16} />
            </a>
          </section>
        ) :
          busy?<section className="empty" role="status"><LoaderCircle className="spin" size={32}/><h2>بندور على الموديل…</h2></section>:
          !searched?<section className="intro"><div className="intro-icon"><Search size={27}/></div><div><h2>ابدأ بكود الموديل</h2><p>بيانات واضحة، سعر البيع، وصور تساعدك تتأكد من اختيارك.</p></div><span className="intro-label">جاهز للاستعلام <span/></span></section>:
          !products.length?<section className="empty"><Search size={33}/><h2>مفيش نتيجة للكود ده</h2><p>راجع كتابة <bdi>{searched}</bdi> أو جرّب رقم الصنف.</p><button className="secondary" onClick={()=>searchInput.current?.focus()}>بحث مرة تانية</button></section>:
          <section className="results" aria-label="نتائج الاستعلام"><div className={`results-heading${products.length===1?" single-result":""}`}><div><span className="eyebrow muted">نتائج الاستعلام</span><h2>لقينا {products.length===1?"الموديل":"أكتر من نتيجة"} <span className="result-count">{products.length}</span></h2></div><span className="query-chip" dir="ltr">{searched}</span></div>
            {truncated && <p role="status">فيه نتائج إضافية؛ استخدم رقم الصنف لتحديد النتيجة.</p>}
            {products.length>1 && <div className="choices">{products.map((p,i)=><button disabled={mutating} className={selected===i?"active":""} key={`${p.id}:${p.unitId}`} onClick={()=>{setSelected(i);setSuccess("");}}><bdi>{p.code}</bdi><span>{p.description||p.name} · {p.unit} · <bdi>{p.id}</bdi></span></button>)}</div>}
            {manage && session.authenticated && queueStatus && (queueStatus.enabled===false||queueStatus.paused||queueStatus.requiresReauth) && <div className="notice warning" role="status"><Clock size={18}/><span>معالجة الصور متوقفة مؤقتًا. تُحفظ الصور وتُعرض كما هي؛ تواصل مع المسؤول.</span></div>}
            {product && <div className="product-layout"><article className="product-details product-summary"><div className="product-kicker">EMOJI STORE {product.kind ? <><span> / </span>{product.kind}</> : null}<span> / </span>{product.name}</div><div className="product-head"><h2>{product.description||product.name}</h2><div className="model-badge"><span>كود الموديل</span><strong dir="ltr">{product.code}</strong></div></div><div className="price-block"><div className="price-main"><span>سعر البيع</span>{product.price===null?<strong className="unpriced">السعر غير متاح حاليًا</strong>:<div><strong>{money(product.price)}</strong><span>ج.م</span></div>}</div><small>سعر الوحدة: {product.unit||"غير محددة"}</small></div></article><div className="gallery"><div className={`main-image ${product.images.length?"has-image":""}`}>{activePhoto?<button className="image-zoom" onClick={()=>setZoom(true)} aria-label="تكبير صورة الموديل" title="تكبير صورة الموديل"><img src={activePhoto.url} alt={`${product.description||product.name} — صورة ${activeImage+1}`}/><span><ZoomIn size={18}/></span></button>:<><div className="no-image"><Images size={48} strokeWidth={1}/><h3>الصور لسه بتتجهز</h3><p>{manage?"أضف أول صورة للموديل من الزر بالأسفل.":"بيانات الموديل متاحة، والصور هتظهر بمجرد إضافتها."}</p></div><span className="gallery-code" dir="ltr">{product.code}</span></>}{manage && session.authenticated && activePhoto && (activePhoto.status==="pending"||activePhoto.status==="processing"||activePhoto.status==="failed") && <span className={`image-status-pill status-${activePhoto.status}`} role="status">{activePhoto.status==="pending"&&<><Clock size={14}/><span>في انتظار المعالجة</span></>}{activePhoto.status==="processing"&&<><LoaderCircle size={14} className="spin"/><span>جاري معالجة الصورة…</span></>}{activePhoto.status==="failed"&&<><AlertTriangle size={14}/><span>تعذرت المعالجة</span></>}</span>}</div>
              {product.images.length>1 && <div className="thumbnails">{product.images.map((photo,i)=><button className={activeImage===i?"selected":""} key={photo.id} onClick={()=>setActiveImage(i)} aria-label={`عرض الصورة ${i+1}`} aria-pressed={activeImage===i}><img src={photo.url} alt=""/>{manage && session.authenticated && (photo.status==="pending"||photo.status==="processing"||photo.status==="failed") && <span className={`thumb-status-dot status-${photo.status}`} aria-hidden="true"/>}</button>)}</div>}
              {manage && <div className="image-actions">
                <label className={`upload-button camera-btn ${mutating||product.images.length>=10?"disabled":""}`} title="تصوير فوري بكاميرا الهاتف">
                  {mutating?<LoaderCircle className="spin" size={18}/>:<Camera size={18}/>}
                  <span>تصوير بالكاميرا</span>
                  <input type="file" accept="image/*" capture="environment" disabled={mutating||product.images.length>=10} onChange={e=>{const file=e.target.files?.[0];if(file)void upload(file);e.target.value="";}}/>
                </label>
                <label className={`upload-button secondary-btn ${mutating||product.images.length>=10?"disabled":""}`} title="اختيار صورة من معرض الهاتف أو الكمبيوتر">
                  <ImagePlus size={18}/>
                  <span>من المعرض</span>
                  <input type="file" accept="image/jpeg,image/png,image/webp,image/*" disabled={mutating||product.images.length>=10} onChange={e=>{const file=e.target.files?.[0];if(file)void upload(file);e.target.value="";}}/>
                </label>
                <span>{product.images.length} / 10 صور</span>
                {activePhoto && <label className={`upload-button replace-btn ${mutating?"disabled":""}`} title="استبدال الصورة الحالية بصورة جديدة">
                  <ImagePlus size={16}/>
                  <span>استبدال الصورة</span>
                  <input type="file" accept="image/jpeg,image/png,image/webp,image/*" disabled={mutating} onChange={e=>{const file=e.target.files?.[0];if(file&&activePhoto)void replaceImage(activePhoto.id,file);e.target.value="";}}/>
                </label>}
                {activePhoto?.status==="failed" && queueStatus?.enabled!==false && <button type="button" className="retry-button" disabled={mutating} onClick={()=>void retryImage(activePhoto.id)}><RefreshCw size={16}/> إعادة المحاولة</button>}
                {activePhoto && <button className="delete-button" disabled={mutating} onClick={()=>setDeleteId(activePhoto.id)}><Trash2 size={16}/> حذف الصورة</button>}
                {activePhoto?.status==="failed" && <small className="image-job-error" role="status">تعذرت معالجة الصورة. يمكنك إعادة المحاولة أو التواصل مع المسؤول.</small>}
                <small>تصوير بالكاميرا أو رفع صورة · JPEG, PNG, WebP</small>
              </div>}
            </div><section className="product-specs" aria-label="مواصفات الصنف"><dl>{product.kind && <div><dt>النوع</dt><dd>{product.kind}</dd></div>}<div><dt>القسم</dt><dd>{product.name}</dd></div>{product.category && <div><dt>التصنيف</dt><dd>{product.category}</dd></div>}<div><dt>رقم الصنف</dt><dd dir="ltr">{product.id}</dd></div><div><dt>الوحدة</dt><dd>{product.unit||"—"}</dd></div></dl><div className="detail-note"><ShieldCheck size={20}/><p>بيانات من نظام الشركة<span>السعر المعروض حسب بيانات الصنف وقت الاستعلام.</span></p></div></section></div>}
          </section>}
      </div>
    </main><footer><span>EMOJI STORE<span className="footer-dot">.</span></span><p>كل التفاصيل، بكود واحد.</p><small>دليل الموديلات للفروع</small></footer>
    <dialog ref={dialog} onCancel={()=>setDeleteId(null)}><div className="dialog-content"><Trash2 size={28}/><h2>حذف الصورة؟</h2><p>هتختفي الصورة من صفحة الاستعلام.</p><div><button className="secondary" disabled={mutating} onClick={()=>setDeleteId(null)}>رجوع</button><button className="danger" disabled={mutating} onClick={remove}>{mutating?"جاري الحذف…":"حذف الصورة"}</button></div></div></dialog>
    <dialog ref={zoomDialog} className="zoom-dialog" onCancel={()=>setZoom(false)}><button className="zoom-close" onClick={()=>setZoom(false)} aria-label="إغلاق الصورة"><X/></button>{product?.images[activeImage] && <img src={product.images[activeImage].url} alt={product.description||product.name}/>}</dialog>
    <dialog
      ref={scannerDialog}
      className="scanner-dialog"
      aria-labelledby="scanner-modal-title"
      {...({closedby:"any"} as any)}
      onCancel={()=>setScannerOpen(false)}
      onPointerDown={e=>{scannerBackdropDown.current=e.target===e.currentTarget;}}
      onClick={e=>{const hit=e.target===e.currentTarget&&scannerBackdropDown.current;scannerBackdropDown.current=false;if(hit&&!("closedBy" in HTMLDialogElement.prototype))setScannerOpen(false);}}
    >
      <div className="scanner-modal-body">
        <div className="scanner-modal-header">
          <div className="scanner-modal-title">
            <ScanBarcode size={22}/>
            <div>
              <h3 id="scanner-modal-title">قارئ باركود الأصناف</h3>
              <p>وجّه الكاميرا على بُعد 15–20 سم نحو باركود الصنف بوضوح</p>
            </div>
          </div>
          <button type="button" className="scanner-close-btn" onClick={()=>setScannerOpen(false)} aria-label="إغلاق الماسح"><X size={20}/></button>
        </div>
        {(!cameraError || capturedPreview) && <div className="scanner-box-wrapper">
          {capturedPreview ? (
            <div className="scanner-captured-container">
              <img src={capturedPreview} alt="صورة الباركود" className="scanner-captured-preview" />
              {scanningFile && (
                <div className="scanner-captured-loading">
                  <LoaderCircle className="spin" size={32} />
                  <span>جاري فحص الباركود وبيانات الصنف…</span>
                </div>
              )}
            </div>
          ) : (
            <>
              <div id="portal-barcode-scanner" className="scanner-preview" />
              <div className="scanner-target-reticle">
                <div className="scanner-laser-line" />
                <span className="reticle-corner tr" />
                <span className="reticle-corner tl" />
                <span className="reticle-corner br" />
                <span className="reticle-corner bl" />
              </div>
            </>
          )}
        </div>}
        {cameraError ? (
          <div className="scanner-error-box">
            <h4>
              {cameraErrorKind==="insecure"
                ? "الكاميرا المباشرة تتطلب اتصال HTTPS آمن"
                : cameraErrorKind==="permission"
                  ? "إذن الكاميرا غير مفعّل"
                  : "تعذر تشغيل الكاميرا المباشرة"}
            </h4>
            <p>
              {cameraErrorKind==="insecure"
                ? "متصفحات الهواتف (iPhone وAndroid) تمنع البث المباشر عبر روابط الشبكة الداخلية (HTTP). استخدم «تصوير الباركود الآن» لالتقاط صورة واضحة بكاميرا الهاتف وقراءتها فوراً:"
                : cameraError}
            </p>
            <div className="scanner-error-actions">
              {cameraErrorKind!=="insecure" && (
                <button type="button" className="scanner-retry-btn" onClick={()=>scannerRetryRef.current?.()}>
                  <RefreshCw size={16}/>
                  <span>إعادة محاولة الكاميرا</span>
                </button>
              )}
              <label className="scanner-snap-btn">
                {scanningFile ? <LoaderCircle className="spin" size={18}/> : <Camera size={18}/>}
                <span>{scanningFile ? "جاري قراءة الباركود…" : (capturedPreview ? "إعادة تصوير الباركود" : "تصوير الباركود الآن")}</span>
                <input type="file" accept="image/*" capture="environment" disabled={scanningFile} onChange={e=>{const f=e.target.files?.[0];if(f)void handleScanFile(f);e.target.value="";}}/>
              </label>
            </div>
            {cameraErrorKind==="insecure" && (
              <details className="scanner-camera-hint">
                <summary>💡 تشغيل الكاميرا المباشرة على iPhone أو Android</summary>
                <div className="camera-hint-box">
                  <p><b>لأجهزة iPhone (Safari):</b> لا يدعم سفاري البث المباشر بدون <code>HTTPS</code>؛ زر <b>«تصوير الباركود الآن»</b> أعلاه يفتح كاميرا الأيفون الأصلية بدقة عالية ويعمل فوراً، أو اطلب من المسؤول تفعيل رابط <code>HTTPS</code>.</p>
                  <p><b>لأجهزة Android (Google Chrome):</b> لتفعيل البث المباشر على الشبكة الداخلية:</p>
                  <ol>
                    <li>افتح تبويب جديد في Google Chrome واكتب: <code>chrome://flags</code></li>
                    <li>ابحث عن: <code>unsafely-treat-insecure-origin-as-secure</code></li>
                    <li>أضف الرابط: <code>{typeof window!=="undefined"?window.location.origin:"http://192.168.1.11:3212"}</code> وفعّله <b>Enabled</b> ثم <b>Relaunch</b>.</li>
                  </ol>
                </div>
              </details>
            )}
          </div>
        ) : (
          <div className="scanner-actions-bar">
            {hasTorch && (
              <button type="button" className={`scanner-action-btn ${torchActive?"active":""}`} onClick={toggleTorch}>
                {torchActive?<FlashlightOff size={18}/>:<Flashlight size={18}/>}
                <span>{torchActive?"إطفاء الكشاف":"تشغيل الكشاف"}</span>
              </button>
            )}
            <label className="scanner-action-btn file-btn">
              <Camera size={18}/>
              <span>التقاط صورة للباركود</span>
              <input type="file" accept="image/*" capture="environment" onChange={e=>{const f=e.target.files?.[0];if(f)void handleScanFile(f);e.target.value="";}}/>
            </label>
          </div>
        )}
        {scanModalError && <div className="scanner-inline-error"><span>{scanModalError}</span></div>}
        <div id="portal-barcode-scanner-file" style={{display:"none"}}/>
      </div>
    </dialog>
    {(!manage || session.authenticated) && !scannerOpen && !zoom && !deleteId && (
      <div className="fab-scan-wrap">
        <button
          type="button"
          className="fab-scan-btn"
          onClick={()=>setScannerOpen(true)}
          title="مسح باركود الصنف بالكاميرا"
          aria-label="مسح باركود الصنف بالكاميرا"
        >
          <span className="fab-scan-pulse" aria-hidden="true" />
          <ScanBarcode size={25} strokeWidth={2.1} />
          <span className="fab-scan-badge" aria-hidden="true">
            <Camera size={11} strokeWidth={2.6} />
          </span>
        </button>
        <span className="fab-scan-tooltip" aria-hidden="true">مسح بالكاميرا</span>
      </div>
    )}
  </div>;
}
createRoot(document.getElementById("root")!).render(<App/>);
