const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../public/js/app.js'),'utf8');
const block=name=>new RegExp(`function ${name}\\([^]*?\\n\\}`).exec(source)[0];

test('static radar backdrop is painted once into the existing wall layer across 30 hover frames',()=>{
  let fills=0,allocations=0;
  const canvasContext=new Proxy({fillRect(){fills++;},createRadialGradient(){return{addColorStop(){}};}},{get:(target,key)=>key in target?target[key]:()=>{}});
  const c={densityCtx:canvasContext,densityW:1200,densityH:700,densityLayoutVersion:1,
    densityVisibleData:[{rx:100,ry:100}],densityMouseX:-1,densityMouseY:-1,densityHover:-1,densitySelectedKey:null,
    densityBubbleLayer:null,densityBubbleLayerVersion:'',window:{devicePixelRatio:1},
    document:{documentElement:{dataset:{}},createElement(){allocations++;return{width:0,height:0,getContext:()=>canvasContext};}},
    getComputedStyle:()=>({getPropertyValue:()=>''}),hexToRgba:()=> '#000',drawDensityBubble(){},findDensityAt:()=>-1,densityEmptyMessage:()=>''};
  vm.createContext(c);
  const backdrop=source.includes('function drawDensityBackdrop(')?block('drawDensityBackdrop'):'',selected=block('findSelectedDensityIndex');
  vm.runInContext(backdrop+'\n'+selected+'\n'+block('getDensityBubblesLayer')+'\n'+block('drawDensityMap'),c);
  for(let i=0;i<30;i++) c.drawDensityMap();
  assert.equal(fills,3,`static background repainted ${fills} times`);
  assert.equal(allocations,1,'reuse the existing cache canvas');
  c.densityLayoutVersion++;c.drawDensityMap();assert.equal(fills,6);
  c.getComputedStyle=()=>({getPropertyValue:name=>name==='--map-bg'?'#ff0000':''});
  c.drawDensityMap();assert.equal(fills,9,'a palette change invalidates the cached backdrop');
  assert.equal(allocations,1);
  c.window.devicePixelRatio=2;c.densityW=3840;c.densityH=2160;c.densityLayoutVersion++;
  const before=fills;for(let i=0;i<3;i++)c.drawDensityMap();
  assert.equal(fills-before,9,'native-resolution rings and labels are preserved when the wall cache is downscaled');
  assert.ok(c.densityBubbleLayer.width*c.densityBubbleLayer.height*4<=32*1024*1024);
  assert.equal(allocations,1);
  c.densityVisibleData=[];c.drawDensityMap();assert.equal(c.densityBubbleLayer,null);
});
