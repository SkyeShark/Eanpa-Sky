// Reusable engine fixture: ordinary primitives, no demo terrain, temple,
// vegetation, imported props or player simulation. The same tier definitions
// and sky factories as the application are used without copied quality knobs.
import * as GPU from 'three';
import * as TSL from 'three/tsl';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {fxaa} from 'three/addons/tsl/display/FXAANode.js';
import {skyQualityPresets} from '../engine/quality_presets.js';
import {makeWeatherSky} from '../src/weathersky.js';
import {makeRingworld} from '../src/ringsky.js';
import {makeShieldworld} from '../src/shieldworld.js';
import {makeSpatialCloudPass} from '../src/cloudspatial.js';
import {makeNativeReflectionPipeline} from '../src/native_reflection_pipeline.js';
import {makeReflectionEnvironment} from '../src/reflection_environment.js';

const T=globalThis.THREE={...GPU,...TSL};globalThis.GLTFLoader=GLTFLoader;globalThis.EANPA_NO_MRT=true;
const errors=[];const error=e=>{errors.push(String(e?.stack??e));document.getElementById('error').textContent=errors.join('\n');};
addEventListener('error',e=>error(e.error??e.message));addEventListener('unhandledrejection',e=>error(e.reason));
const originalError=console.error;console.error=(...args)=>{error(args.join(' '));originalError(...args);};
const search=new URLSearchParams(location.search),tier=search.get('quality')??'balanced';
const quality=skyQualityPresets()[tier],kind=search.get('sky')??'earth';
if(!quality)throw new Error('Unknown quality tier');
const renderer=new T.WebGPURenderer({antialias:false,powerPreference:'high-performance',trackTimestamp:true});
await renderer.init();renderer.setSize(innerWidth,innerHeight);renderer.toneMapping=T.ACESFilmicToneMapping;
renderer.toneMappingExposure=1;renderer.shadowMap.enabled=true;
document.body.appendChild(renderer.domElement);renderer.backend.device.addEventListener('uncapturederror',e=>error(e.error));
const scene=new T.Scene(),camera=new T.PerspectiveCamera(62,innerWidth/innerHeight,.18,60000);
camera.position.set(0,2.2,13);camera.lookAt(0,1,-8);scene.add(camera);
const sun=new T.DirectionalLight(0xffffff,3),hemi=new T.HemisphereLight(0xa6c8ef,0x655447,1);
sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);Object.assign(sun.shadow.camera,{left:-50,right:50,top:50,bottom:-50,near:1,far:300});
scene.add(sun,sun.target,hemi);
const host=new T.Group();host.name='generic-host-geometry';scene.add(host);
function mesh(geometry,material,position){const m=new T.Mesh(geometry,material);m.position.fromArray(position);m.castShadow=m.receiveShadow=true;host.add(m);return m;}
const stone=new T.MeshStandardNodeMaterial({color:0x807466,roughness:.8});
stone.colorNode=T.mix(T.color(0x716a5e),T.color(0x9a8b78),T.fract(T.positionWorld.x.mul(.15)).smoothstep(.1,.9));
mesh(new T.BoxGeometry(180,.4,180),stone,[0,-.2,0]);
mesh(new T.BoxGeometry(8,1,8),stone,[-7,4,-9]);
mesh(new T.BoxGeometry(2,8,2),stone,[8,4,-13]);
const slope=mesh(new T.BoxGeometry(7,.5,5),stone,[-6,1.5,4]);slope.rotation.z=.16;
const chrome=new T.MeshStandardNodeMaterial({color:0xffffff,metalness:1,roughness:.06});
const sphere=mesh(new T.SphereGeometry(1.3,48,24),chrome,[0,1.4,-3]);sphere.userData.noWet=true;sphere.userData.ssrConvexGroup='fixture-sphere';
const moving=mesh(new T.TorusKnotGeometry(.42,.13,64,8),chrome,[2.3,1.3,1]);moving.userData.noWet=true;
const light=new T.SpotLight(0xeaf6ff,330,80,.5,.65,2);light.position.set(0,2,5);light.target.position.set(0,0,-2);scene.add(light,light.target);
const textures=new Map();globalThis.loadImageTexture=async(url,{srgb=false,mipmaps=false}={})=>{
    const key=url+srgb+mipmaps;if(textures.has(key))return textures.get(key);
    const promise=(async()=>{const bitmap=await createImageBitmap(await(await fetch(url)).blob());
        const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);
        const {data,width,height}=ctx.getImageData(0,0,canvas.width,canvas.height);bitmap.close();
        const bytes=new Uint8Array(data.length),row=width*4;
        for(let y=0;y<height;y++)bytes.set(data.subarray((height-1-y)*row,(height-y)*row),y*row);
        const texture=new T.DataTexture(bytes,width,height);texture.colorSpace=srgb?T.SRGBColorSpace:T.NoColorSpace;
        texture.generateMipmaps=mipmaps;texture.minFilter=mipmaps?T.LinearMipmapLinearFilter:T.LinearFilter;texture.magFilter=T.LinearFilter;texture.needsUpdate=true;return texture;
    })();textures.set(key,promise);return promise;
};
const loadEngine=name=>import('/engine/'+name);
const factory={earth:makeWeatherSky,ringworld:makeRingworld,shieldworld:makeShieldworld}[kind];
const active=await factory({THREE:T,scene,camera,renderer,sun,hemi,loadEngine,quality,
    hours:Number(search.get('tod')??11),worldRayDir:true,cloudPreset:'cumulus',weatherState:'none'});
await active.preloadWeather();const sky=active.sky,weather=__eanpaWeatherByScene.get(scene);
weather.wrapScene();for(let i=0;i<30;i++)weather.update(i*.01,camera);
weather.setWeather(search.get('weather')??'rain');
weather.uniforms.wetness.value=weather.uniforms.wetTarget.value;
weather.uniforms.surfaceWater.value=Math.pow(weather.uniforms.wetTarget.value,1.8);
active.update(0);sky.wrapCloudShadows(scene);
const spatial=makeSpatialCloudPass(T,renderer,camera,{div:quality.cloudDiv});spatial.attach(scene,sky);
const environment=makeReflectionEnvironment(T,renderer);
const pipeline=makeNativeReflectionPipeline(T,renderer,scene,camera,sky,quality,fxaa);
const baked=await sky.bakeEnv(renderer,{...quality.reflectionBake,assign:false});
pipeline.setEnvironment(environment.update(baked));pipeline.localProbe.configure({sampleGroundHeight:()=>0});
globalThis._sky=sky;globalThis._c=camera;globalThis._reflectionPipeline=pipeline;globalThis._spatialClouds=spatial;
const state=globalThis._eanpaTest={paused:true,pauseAfterFrame:false,completedFrames:0};
const fixture=globalThis.__skyFixture={renderer,scene,camera,host,sky,weather,pipeline,spatial,active,errors,
    kind,tier,quality,ready:false,time:0,mode:'effects',animateCamera:false,moving,
    environmentStats:environment.stats,nextEnvironmentAt:quality.cloudReflectionRefreshSeconds,
    async frame(time=this.time+1/60){
        globalThis._frameStage='sky-update';
        this.time=time;active.update(time,1/60);
        if(time>=this.nextEnvironmentAt){
            globalThis._frameStage='sky-reflection-bake';
            const baked=await sky.bakeEnv(renderer,{...quality.reflectionBake,assign:false});
            pipeline.setEnvironment(environment.update(baked));
            this.nextEnvironmentAt=time+quality.cloudReflectionRefreshSeconds;
        }
        if(this.animateCamera){camera.position.set(Math.sin(time*.35)*3,2.2,13+Math.cos(time*.35)*3);camera.lookAt(0,1,-8);}
        moving.rotation.y=time*.3;scene.updateMatrixWorld(true);
        await active.prepareFrame?.(renderer,camera);
        globalThis._frameStage='rain-surface';
        await weather.prepareFrame(renderer,camera);await sky.prepareCloudShadows(renderer,camera);
        globalThis._frameStage='spatial-clouds';
        await spatial.render();globalThis._frameStage='reflection-pipeline';
        await pipeline.render();state.completedFrames++;
    },
};
document.getElementById('progress').textContent='Compiling sky, weather and reflection passes…';
const warm=active.weatherWarmupObjects(),visibility=warm.map(o=>o.visible);warm.forEach(o=>o.visible=true);
await spatial.compileAsync();await pipeline.compileAsync();
for(let i=0;i<3;i++)await fixture.frame(i/60);
warm.forEach((o,i)=>o.visible=visibility[i]);await renderer.backend.device.queue.onSubmittedWorkDone();
fixture.ready=true;state.paused=false;
document.getElementById('progress').textContent=`${kind} · ${tier} · reusable effects with generic surfaces`;
let busy=false;const started=performance.now();
function frame(){requestAnimationFrame(frame);if(busy||state.paused)return;busy=true;
    fixture.frame((performance.now()-started)/1000).catch(error).finally(()=>{busy=false;if(state.pauseAfterFrame){state.pauseAfterFrame=false;state.paused=true;}});
}requestAnimationFrame(frame);
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);spatial.resize?.();pipeline.resize(innerWidth,innerHeight);});
