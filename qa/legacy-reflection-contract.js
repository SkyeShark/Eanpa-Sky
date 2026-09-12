(async()=>{
const T=THREE,f=__skyFixture,r=f.renderer,p=f.pipeline;
if(p.ssrImplementation!=='eanpa-continuous-depth-native-pbr-response')throw new Error('Load the fixture with legacy_reflections=1');
const wasPaused=_eanpaTest.paused;
_eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(done=>setTimeout(done,10));
const target=new T.RenderTarget(128,72,{type:T.FloatType,depthBuffer:false});
const material=new T.MeshBasicNodeMaterial();material.fragmentNode=T.vec4(p.ssrNode.a,0,0,1);
const quad=new T.QuadMesh(material),state=T.RendererUtils.saveRendererState(r);
try{
 r.setMRT(null);r.setRenderTarget(target);await new Promise(requestAnimationFrame);quad.render(r);
 const pixels=await r.readRenderTargetPixelsAsync(target,0,0,128,72);
 let hits=0,finite=true,max=0;for(let i=0;i<pixels.length;i+=4){finite&&=Number.isFinite(pixels[i]);if(pixels[i]>.001)hits++;max=Math.max(max,pixels[i]);}
 return {pass:finite&&hits>5&&max<=1.001&&!f.errors.length,hits,max,finite,errors:[...f.errors],implementation:p.ssrImplementation};
}finally{T.RendererUtils.restoreRendererState(r,state);material.dispose();target.dispose();_eanpaTest.paused=wasPaused;_eanpaTest.pauseAfterFrame=false;}
})()
