import { useEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { ArrowLeft, Camera, Check, Flashlight, FlashlightOff, ImagePlus, Images, LoaderCircle, LockKeyhole, LogOut, ScanBarcode, Search, ShieldCheck, Trash2, X, ZoomIn } from "lucide-react";
import { Html5Qrcode, Html5QrcodeSupportedFormats } from "html5-qrcode";
import { BarcodeFormat, BinaryBitmap, DecodeHintType, GlobalHistogramBinarizer, HybridBinarizer, MultiFormatReader, RGBLuminanceSource } from "@zxing/library";
import "./styles.css";
type Photo={id:string;url:string};
type Product={id:string;unitId:string;code:string;name:string;category:string;description:string;unit:string;price:number|null;images:Photo[]};
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
  const [scannerOpen,setScannerOpen]=useState(false),[torchActive,setTorchActive]=useState(false),[hasTorch,setHasTorch]=useState(false),[cameraError,setCameraError]=useState(""),[scanningFile,setScanningFile]=useState(false),[scanModalError,setScanModalError]=useState(""),[capturedPreview,setCapturedPreview]=useState<string|null>(null);
  const searchInput=useRef<HTMLInputElement>(null),sequence=useRef(0),dialog=useRef<HTMLDialogElement>(null),zoomDialog=useRef<HTMLDialogElement>(null),scannerDialog=useRef<HTMLDialogElement>(null),scannerRef=useRef<Html5Qrcode|null>(null);
  const product=products[selected];
  useEffect(()=>{void request("/session").then(setSession).catch(e=>{if(manage)setError(e.message);}).finally(()=>setSessionLoading(false));},[manage]);
  useEffect(()=>{setActiveImage(0);},[selected]);
  useEffect(()=>{if(deleteId)dialog.current?.showModal();else dialog.current?.close();},[deleteId]);
  useEffect(()=>{if(zoom)zoomDialog.current?.showModal();else zoomDialog.current?.close();},[zoom]);
  useEffect(()=>{if(scannerOpen)scannerDialog.current?.showModal();else scannerDialog.current?.close();},[scannerOpen]);
  useEffect(()=>{return ()=>{if(capturedPreview)URL.revokeObjectURL(capturedPreview);};},[capturedPreview]);
  useEffect(()=>{if(activeSuggestion>=0)document.getElementById(`model-suggestion-${activeSuggestion}`)?.scrollIntoView({block:"nearest"});},[activeSuggestion]);
  useEffect(()=>{
    if(!suggestionsOpen || !code.trim() || mutating || (manage && !session.authenticated)) {
      setSuggestions([]);setSuggesting(false);return;
    }
    if(!/^[A-Za-z0-9_\-]+$/.test(code.trim())) {
      setSuggestions([]);setSuggesting(false);setSuggestionError("اكتب حروف وأرقام، بدون مسافات.");return;
    }
    const controller=new AbortController();let current=true;
    setSuggesting(true);setSuggestionError("");
    const timer=setTimeout(()=>{
      void request(`/suggestions?code=${encodeURIComponent(code.trim())}`,"GET",undefined,controller.signal)
        .then(result=>{if(current){setSuggestions(result.suggestions);setActiveSuggestion(-1);}})
        .catch(e=>{if(current && e.name!=="AbortError")setSuggestionError(e.message);})
        .finally(()=>{if(current)setSuggesting(false);});
    },250);
    return ()=>{current=false;clearTimeout(timer);controller.abort();};
  },[code,suggestionsOpen,mutating,manage,session.authenticated]);
  function editCode(value:string){setCode(value.trim());setSuggestions([]);setActiveSuggestion(-1);setSuggestionsOpen(true);}
  async function runSearch(value:string,choice?:Product) {
    if(mutating || !value.trim())return;
    setSuggestionsOpen(false);setSuggestions([]);setActiveSuggestion(-1);
    const current=++sequence.current;setBusy(true);setError("");setSuccess("");setProducts([]);setSelected(0);setActiveImage(0);setSearched("");
    try {
      const path=choice?`/products/${choice.id}/${choice.unitId}`:`/products?code=${encodeURIComponent(value.trim())}`;
      const result=await request(path);
      if(current===sequence.current){setProducts(result.products);setTruncated(result.truncated);setSearched(value.trim());}
    }
    catch(e){if(current===sequence.current)setError((e as Error).message);}
    finally{if(current===sequence.current)setBusy(false);}
  }
  function chooseSuggestion(choice:Product){setCode(choice.code);void runSearch(choice.code,choice);}
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
          hints.set(DecodeHintType.POSSIBLE_FORMATS, [
            BarcodeFormat.CODE_128,
            BarcodeFormat.CODE_39,
            BarcodeFormat.EAN_13,
            BarcodeFormat.EAN_8,
            BarcodeFormat.UPC_A,
            BarcodeFormat.UPC_E,
            BarcodeFormat.QR_CODE,
            BarcodeFormat.ITF,
          ]);

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

          // Pass 4: Center crop (middle 70% width, 60% height) at native resolution
          const cropW = Math.round(naturalW * 0.7);
          const cropH = Math.round(naturalH * 0.6);
          const startX = Math.round((naturalW - cropW) / 2);
          const startY = Math.round((naturalH - cropH) / 2);
          const cCrop = document.createElement("canvas");
          cCrop.width = cropW;
          cCrop.height = cropH;
          const ctxCrop = cCrop.getContext("2d");
          if (ctxCrop) {
            ctxCrop.drawImage(img, startX, startY, cropW, cropH, 0, 0, cropW, cropH);
            const resCrop = tryDecodeCanvas(cCrop);
            if (resCrop) { cleanup(); return resolve(resCrop); }

            // Crop rotated 90°
            const cCrop90 = document.createElement("canvas");
            cCrop90.width = cropH;
            cCrop90.height = cropW;
            const ctxCrop90 = cCrop90.getContext("2d");
            if (ctxCrop90) {
              ctxCrop90.translate(cropH / 2, cropW / 2);
              ctxCrop90.rotate((90 * Math.PI) / 180);
              ctxCrop90.drawImage(cCrop, -cropW / 2, -cropH / 2, cropW, cropH);
              const resCrop90 = tryDecodeCanvas(cCrop90);
              if (resCrop90) { cleanup(); return resolve(resCrop90); }
            }
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
    const startScanner = async () => {
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
          verbose: false,
        });
        scannerRef.current = html5QrCode;
        await html5QrCode.start(
          { facingMode: "environment" },
          {
            fps: 15,
            qrbox: (w, h) => {
              const width = Math.min(w * 0.88, 320);
              const height = Math.min(width * 0.5, 160);
              return { width, height };
            },
            aspectRatio: 1.0,
          },
          (decodedText) => {
            if (!active) return;
            active = false;
            onBarcodeScanned(decodedText);
          },
          () => {}
        );
        try {
          const cap = html5QrCode.getRunningTrackCameraCapabilities();
          if (cap && cap.torchFeature && cap.torchFeature().isSupported()) {
            setHasTorch(true);
          }
        } catch {}
      } catch (err: any) {
        if (!active) return;
        setCameraError(err?.message || "تعذر فتح الكاميرا المباشرة؛ يمكنك التقاط صورة للباركود أدناه.");
      }
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
  async function logout(){try{await request("/logout","POST");setSession({authenticated:false,username:null});setSuccess("");}catch(e){setError((e as Error).message);}}
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
      setActiveImage(result.images.length-1);setSuccess("تمت إضافة الصورة");
    }catch(e){setError((e as Error).message);}finally{setMutating(false);}
  }
  async function remove(){if(!deleteId)return;setMutating(true);setError("");setSuccess("");
    try{await request(`/images/${deleteId}`,"DELETE");setProducts(current=>current.map(p=>({...p,images:p.images.filter(i=>i.id!==deleteId)})));setActiveImage(0);setSuccess("تم حذف الصورة");}
    catch(e){setError((e as Error).message);}finally{setDeleteId(null);setMutating(false);}}
  return <div className="portal">
    <header className="topbar"><a className="brand" href="/" aria-label="إيموجي ستور — الاستعلام"><img src="/emoji-logo.png" alt="EMOJI STORE"/><span className="brand-divider"/><span>دليل الموديلات<span className="brand-sub">EMOJI STORE CATALOG</span></span></a>
      <nav>{manage?<a href="/">الاستعلام <ArrowLeft size={16}/></a>:<a href="/manage"><LockKeyhole size={15}/> إدارة الصور</a>}{manage && session.authenticated && <button className="nav-logout" onClick={logout} disabled={mutating}><LogOut size={16}/> خروج</button>}</nav></header>
    <main>
      <section className="hero"><div className="hero-copy"><div className="eyebrow"><span/> {manage?"مساحة إدارة الصور":"كل موديل، في مكان واحد"}</div><h1>{manage?<>صورة أوضح.<br/><span>للموديل الصح.</span></>:<>الموديل اللي بتدور عليه،<br/><span>تفاصيله هنا.</span></>}</h1><p>{manage?"ابحث عن الموديل وأضف صوره ليشاهدها فريق الفروع.":"اكتب كود الموديل أو رقم الصنف، واعرف سعره وتفاصيله وصوره."}</p>
        {(!manage || session.authenticated) && <form className="search-form" onSubmit={search} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))setSuggestionsOpen(false);}}>
          <label htmlFor="model-code">كود الموديل أو رقم الصنف</label>
          <div className="search-input-wrap"><div className="search-control"><Search size={23}/>
            <input id="model-code" ref={searchInput} dir="ltr" value={code} onChange={e=>editCode(e.target.value)} onFocus={()=>setSuggestionsOpen(true)} placeholder="Z3330" autoComplete="off" maxLength={100} pattern="[A-Za-z0-9_\-]+" title="حروف إنجليزية وأرقام وكود الباركود" required disabled={mutating}
              role="combobox" aria-autocomplete="list" aria-expanded={suggestionsOpen && Boolean(code.trim())} aria-controls="model-suggestions" aria-activedescendant={suggestionsOpen && activeSuggestion>=0?`model-suggestion-${activeSuggestion}`:undefined}
              onKeyDown={e=>{
                if(e.key==="Escape"){e.preventDefault();setSuggestionsOpen(false);setActiveSuggestion(-1);}
                if(e.key==="ArrowDown" || e.key==="ArrowUp"){e.preventDefault();setSuggestionsOpen(true);if(suggestions.length)setActiveSuggestion(i=>e.key==="ArrowDown"?(i+1)%suggestions.length:(i<=0?suggestions.length-1:i-1));}
                if(e.key==="Enter" && suggestionsOpen && activeSuggestion>=0 && suggestions[activeSuggestion]){e.preventDefault();chooseSuggestion(suggestions[activeSuggestion]);}
              }}/>
            <button type="button" className="barcode-scan-btn" onClick={()=>setScannerOpen(true)} title="مسح باركود الصنف بالكاميرا" aria-label="مسح باركود الصنف بالكاميرا"><ScanBarcode size={21}/></button>
            <button type="submit" className="search-submit-btn" disabled={busy||mutating||!code.trim()}>{busy?<LoaderCircle className="spin" size={20}/>:<>ابحث <ArrowLeft size={18}/></>}</button>
          </div>
          {suggestionsOpen && code.trim() && <div className="suggestion-panel"><div className="suggestion-title">اقتراحات كود الموديل</div>
            <div role="listbox" id="model-suggestions" aria-label="اقتراحات كود الموديل" aria-busy={suggesting}>
              {suggestions.map((p,i)=><button type="button" role="option" tabIndex={-1} aria-selected={activeSuggestion===i} id={`model-suggestion-${i}`} className="model-suggestion" key={`${p.id}:${p.unitId}`} onMouseDown={e=>e.preventDefault()} onClick={()=>chooseSuggestion(p)}><strong dir="ltr">{p.code}</strong><span>{p.description||p.name}<small>{p.unit} · رقم الصنف <bdi>{p.id}</bdi></small></span><ArrowLeft size={16}/></button>)}
            </div>
            {suggesting?<p className="suggestion-status" role="status">جاري تحميل الاقتراحات…</p>:suggestionError?<p className="suggestion-status" role="status">{suggestionError}</p>:!suggestions.length?<p className="suggestion-status" role="status">مفيش كود موديل مطابق. لو بتبحث برقم الصنف، اكتبه كامل واضغط ابحث.</p>:null}
          </div>}
          </div><div className="search-hint">اكتب جزء من كود الموديل واختار من الاقتراحات، أو اكتب رقم الصنف كامل واضغط ابحث.</div>
        </form>}
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
          <section className="results" aria-label="نتائج الاستعلام"><div className="results-heading"><div><span className="eyebrow muted">نتائج الاستعلام</span><h2>لقينا {products.length===1?"الموديل":"أكتر من نتيجة"} <span className="result-count">{products.length}</span></h2></div><span className="query-chip" dir="ltr">{searched}</span></div>
            {truncated && <p role="status">فيه نتائج إضافية؛ استخدم رقم الصنف لتحديد النتيجة.</p>}
            {products.length>1 && <div className="choices">{products.map((p,i)=><button disabled={mutating} className={selected===i?"active":""} key={`${p.id}:${p.unitId}`} onClick={()=>{setSelected(i);setSuccess("");}}><bdi>{p.code}</bdi><span>{p.description||p.name} · {p.unit} · <bdi>{p.id}</bdi></span></button>)}</div>}
            {product && <div className="product-layout"><div className="gallery"><div className={`main-image ${product.images.length?"has-image":""}`}>{product.images[activeImage]?<button className="image-zoom" onClick={()=>setZoom(true)} aria-label="تكبير صورة الموديل" title="تكبير صورة الموديل"><img src={product.images[activeImage].url} alt={`${product.description||product.name} — صورة ${activeImage+1}`}/><span><ZoomIn size={18}/></span></button>:<div className="no-image"><Images size={48} strokeWidth={1}/><h3>الصور لسه بتتجهز</h3><p>{manage?"أضف أول صورة للموديل من الزر بالأسفل.":"بيانات الموديل متاحة، والصور هتظهر بمجرد إضافتها."}</p></div>}<span className="gallery-code" dir="ltr">{product.code}</span></div>
              {product.images.length>1 && <div className="thumbnails">{product.images.map((photo,i)=><button className={activeImage===i?"selected":""} key={photo.id} onClick={()=>setActiveImage(i)} aria-label={`عرض الصورة ${i+1}`} aria-pressed={activeImage===i}><img src={photo.url} alt=""/></button>)}</div>}
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
                {product.images[activeImage] && <button className="delete-button" disabled={mutating} onClick={()=>setDeleteId(product.images[activeImage].id)}><Trash2 size={16}/> حذف الصورة</button>}
                <small>تصوير بالكاميرا أو رفع صورة · JPEG, PNG, WebP</small>
              </div>}
            </div><article className="product-details"><div className="product-kicker">EMOJI STORE <span> / </span> {product.name}</div><h2>{product.description||product.name}</h2><div className="model-badge">كود الموديل <strong dir="ltr">{product.code}</strong></div><div className="price-block"><span>سعر البيع</span>{product.price===null?<strong className="unpriced">السعر غير متاح حاليًا</strong>:<div><strong>{money(product.price)}</strong><span>ج.م</span></div>}<small>سعر الوحدة: {product.unit||"غير محددة"}</small></div><dl><div><dt>رقم الصنف</dt><dd dir="ltr">{product.id}</dd></div>{product.category && <div><dt>التصنيف</dt><dd>{product.category}</dd></div>}<div><dt>الصنف</dt><dd>{product.name}</dd></div><div><dt>الوحدة</dt><dd>{product.unit||"—"}</dd></div></dl><div className="detail-note"><ShieldCheck size={20}/><p>بيانات من نظام الشركة<span>السعر المعروض حسب بيانات الصنف وقت الاستعلام.</span></p></div></article></div>}
          </section>}
      </div>
    </main><footer><span>EMOJI STORE<span className="footer-dot">.</span></span><p>كل التفاصيل، بكود واحد.</p><small>دليل الموديلات للفروع</small></footer>
    <dialog ref={dialog} onCancel={()=>setDeleteId(null)}><div className="dialog-content"><Trash2 size={28}/><h2>حذف الصورة؟</h2><p>هتختفي الصورة من صفحة الاستعلام.</p><div><button className="secondary" disabled={mutating} onClick={()=>setDeleteId(null)}>رجوع</button><button className="danger" disabled={mutating} onClick={remove}>{mutating?"جاري الحذف…":"حذف الصورة"}</button></div></div></dialog>
    <dialog ref={zoomDialog} className="zoom-dialog" onCancel={()=>setZoom(false)}><button className="zoom-close" onClick={()=>setZoom(false)} aria-label="إغلاق الصورة"><X/></button>{product?.images[activeImage] && <img src={product.images[activeImage].url} alt={product.description||product.name}/>}</dialog>
    <dialog ref={scannerDialog} className="scanner-dialog" {...({closedby:"any"} as any)} onCancel={()=>setScannerOpen(false)} onClick={e=>{if(e.target===e.currentTarget)setScannerOpen(false);}}>
      <div className="scanner-modal-body">
        <div className="scanner-modal-header">
          <div className="scanner-modal-title">
            <ScanBarcode size={22}/>
            <div>
              <h3>قارئ باركود الأصناف</h3>
              <p>وجّه الكاميرا نحو باركود الصنف أو التيكت</p>
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
            <h4>الكاميرا المباشرة تتطلب اتصال HTTPS آمن</h4>
            <p>متصفحات الهواتف تمنع فتح الفيديو المباشر عبر روابط الشبكة الداخلية (HTTP) لأسباب أمنية. يمكنك تصوير الباركود الآن مباشرة كصورة وسيقوم النظام بقراءته فوراً:</p>
            <label className="scanner-snap-btn">
              {scanningFile ? <LoaderCircle className="spin" size={18}/> : <Camera size={18}/>}
              <span>{scanningFile ? "جاري قراءة الباركود…" : (capturedPreview ? "إعادة تصوير الباركود" : "تصوير الباركود الآن")}</span>
              <input type="file" accept="image/*" capture="environment" disabled={scanningFile} onChange={e=>{const f=e.target.files?.[0];if(f)void handleScanFile(f);e.target.value="";}}/>
            </label>
            <details className="scanner-camera-hint">
              <summary>💡 كيف تشغل الكاميرا المباشرة بدون تصوير؟</summary>
              <div className="camera-hint-box">
                <p>متصفح كروم يمنع الفيديو المباشر عبر روابط الشبكة الداخلية (HTTP). لتفعيله مرة واحدة وسريعة في هاتفك:</p>
                <ol>
                  <li>افتح تبويب جديد في Google Chrome واكتب: <code>chrome://flags</code></li>
                  <li>ابحث عن: <code>unsafely-treat-insecure-origin-as-secure</code></li>
                  <li>اكتب الرابط: <code>http://192.168.1.11:3212</code> وفعّله <b>Enabled</b></li>
                  <li>اضغط <b>Relaunch</b> لإعادة تشغيل كروم وستفتح الكاميرا المباشرة فوراً كفيديو حي دون الحاجة لالتقاط صور.</li>
                </ol>
              </div>
            </details>
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
