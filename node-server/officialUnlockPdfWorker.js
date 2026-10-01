"use strict";
const {parentPort,workerData}=require("node:worker_threads");
const {parsePlanPages}=require("./officialUnlockPlans");
(async()=>{
  let loading;
  try {
    const {getDocument}=await import("pdfjs-dist/legacy/build/pdf.mjs");
    loading=getDocument({data:workerData,isEvalSupported:false,useSystemFonts:false,disableFontFace:true,verbosity:0,stopAtErrors:true});
    const doc=await loading.promise;
    if(doc.numPages>8)throw new Error("Plan too long");
    const pages=[];
    for(let page=1;page<=doc.numPages;page++){
      const p=await doc.getPage(page),text=await p.getTextContent();
      if(text.items.length>25000)throw new Error("Plan too complex");
      pages.push(text.items.map(({str,transform})=>({str,transform})));p.cleanup();
    }
    const points=parsePlanPages(pages);
    await loading.destroy();loading=null;
    parentPort.postMessage({points});
  }catch(_){await loading?.destroy().catch(()=>{});parentPort.postMessage({error:"Unsupported project supply document"});}
})();
