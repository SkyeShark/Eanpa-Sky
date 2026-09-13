// Run the real CLI with synthetic OS/CDP boundaries. No browser, server,
// network request, or temporary profile is created by these failure tests.
import {SourceTextModule, SyntheticModule, createContext} from 'node:vm';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

const source=await readFile(new URL('../../qa/performance-review.mjs',import.meta.url),'utf8');
async function exercise(scenario) {
    const events=[],children=[],listeners=new Map();
    let at=1000,shots=0,report,closed=false,removed=false,measurementStarted=false;
    let stream=scenario==='absent-stream'?null:{state:scenario==='disabled-stream'?'disabled':'preview'};
    const finish=child=>{child.exitCode=0;queueMicrotask(()=>child.emit('exit',0));};
    const spawn=(command,args,options)=>{
        if(options.windowsHide!==true)throw Error('QA child requested a visible window');
        const child=new EventEmitter();child.exitCode=null;child.signalCode=null;
        child.role=args[0]==='qa/dev-server.py'?'server':args[0]==='qa/startup-profile.mjs'?'startup':'browser';
        child.kill=()=>{events.push('kill:'+child.role);finish(child);};
        children.push(child);
        queueMicrotask(()=>{
            child.emit('spawn');
            if(child.role==='startup'){
                child.exitCode=scenario==='startup-fails'?1:0;child.emit('exit',child.exitCode);
            }
        });
        return child;
    };
    const createConnection=({port})=>{
        const socket=new EventEmitter();socket.setTimeout=()=>socket;socket.destroy=()=>{};
        queueMicrotask(()=>{
            const role=port===8378?'server':'browser';
            socket.emit(children.some(c=>c.role===role&&c.exitCode===null)?'connect':'error');
        });
        return socket;
    };
    const cdp={
        on(name,listener){listeners.set(name,listener);},
        close(){closed=true;events.push('cdp-close');if(scenario==='connection-close-fails')throw Error('Injected connection cleanup failure');},
        async send(method){
            if(method==='Runtime.enable')return{};
            if(method==='Browser.close'){events.push('browser-close');finish(children.find(c=>c.role==='browser'));return{};}
            if(method!=='Page.captureScreenshot')throw Error('Unexpected CDP command: '+method);
            shots++;
            if(scenario==='late-console-error'&&shots===3)
                listeners.get('Runtime.consoleAPICalled')({type:'error',args:[{value:'Injected late renderer error'}]});
            return{data:''};
        },
        async evaluate(expression){
            if(expression.includes('pipelineFailures:'))return{
                failedFrames:scenario==='late-frame-failure'&&shots>=3?1:0,
                pipelineFailures:scenario==='late-pipeline-failure'&&shots>=3?1:0,
                cloudFailures:scenario==='late-cloud-failure'&&shots>=3?1:0,errors:[],
            };
            if(expression.includes('navigator.gpu.requestAdapter'))return{vendor:'synthetic',description:'No real GPU used'};
            if(expression.startsWith('({frames:'))return{frames:6,pipelines:12,stream,effects:null};
            if(expression.includes('const m=globalThis.__textureUpgradeMeasurement')){measurementStarted=true;stream={state:'complete'};return;}
            if(expression.startsWith("['complete','failed']"))return true;
            if(expression==='__textureUpgradeMeasurement.done')return true;
            if(expression.includes('const m=__textureUpgradeMeasurement;return'))return{durationMs:16.7,maxAnimationFrameIntervalMs:16.7,completedResourceBytes:1000};
            if(expression==='_eanpaTest.paused=false')return false;
            if(expression.startsWith('!!document.getElementById'))return false;
            if(expression.includes('globalThis.__switchReady=null')){at+=100;return{at,frames:6,pipelines:12,stageIndex:0};}
            if(expression.startsWith('__switchReady &&'))return true;
            if(expression.startsWith('({at:'))return{at:at+20,pipelines:12,warmup:{weatherGraphReady:true},stages:[{text:'ready',at:at+10}],effects:null};
            throw Error('Unexpected CDP expression: '+expression);
        },
    };
    const initial={valid:scenario!=='invalid-startup',profile:{readyAt:500},
        warmup:{weatherGraphReady:scenario!=='incomplete-warmup'},failedFrames:scenario==='initial-frame-failure'?1:0,
        settings:{quality:'balanced'},resources:[]};
    const temporaryRoot=path.resolve('synthetic-temporary-root');
    const modules={
        'node:child_process':{spawn},'node:net':{createConnection},
        'node:fs/promises':{
            async mkdir(){},async mkdtemp(){return path.join(temporaryRoot,'eanpa-performance-test');},
            async open(){return{fd:7,async close(){}};},async readFile(){return JSON.stringify(initial);},
            async writeFile(name,bytes){
                if(String(name).endsWith('report.json')){
                    report=JSON.parse(bytes);
                    if(scenario==='report-write-fails')throw Error('ENOSPC: injected report failure');
                }
            },
            async rm(){removed=true;events.push('profile-remove');},
        },
        'node:os':{tmpdir:()=>temporaryRoot},
        'node:path':{join:path.join,resolve:path.resolve,basename:path.basename,dirname:path.dirname},
        'node:url':{fileURLToPath},'./cdp.mjs':{connect:async()=>cdp},
    };
    const fakeProcess={argv:['node','runner','fault-check'],env:{},platform:'win32',execPath:'synthetic-node',exitCode:0};
    const context=createContext({process:fakeProcess,Buffer,URL,console:{log(){},error(){}},
        setTimeout:fn=>setTimeout(fn,0),clearTimeout,queueMicrotask});
    const url=new URL('../../qa/performance-review.mjs',import.meta.url).href;
    const module=new SourceTextModule(source,{context,identifier:url,initializeImportMeta(meta){meta.url=url;}});
    await module.link(specifier=>{
        const values=modules[specifier];if(!values)throw Error('Unexpected import '+specifier);
        return new SyntheticModule(Object.keys(values),function(){
            for(const [key,value]of Object.entries(values))this.setExport(key,value);
        },{context});
    });
    let error=null,causes=[];
    try{await module.evaluate();}catch(e){error=String(e.message);causes=Array.from(e.errors??[],cause=>String(cause.message));}
    return{scenario,reportValid:report?.valid,reportedError:report?.error,exitCode:fakeProcess.exitCode,
        error,causes,upgrade:report?.textureUpgrade??null,measurementStarted,closed,removed,
        childrenExited:children.every(c=>c.exitCode!==null),events};
}
const scenarios=['control','absent-stream','disabled-stream','report-write-fails','connection-close-fails',
    'startup-fails','invalid-startup','incomplete-warmup','initial-frame-failure',
    'late-frame-failure','late-pipeline-failure','late-cloud-failure','late-console-error'];
const results=[];
for(const scenario of scenarios)results.push(await exercise(scenario));
console.log(JSON.stringify(results));
