// Decode the actual runtime assets without opening an audio output device.
import { connect } from './cdp.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const source = await readFile(new URL('../src/audio_system.js', import.meta.url), 'utf8');
const inventory = source.slice(source.indexOf('const FILES ='), source.indexOf('// Retain the original'));
const files = [...new Set([...inventory.matchAll(/'([^']+\.(?:ogg|wav|mp3))'/g)].map(m => m[1]))];
const cdp = await connect();
try {
    const result = await cdp.evaluate(`(async()=>{
        const context=new OfflineAudioContext(2,1,48000),rows=[];
        const {blendAmbienceLoop}=await import('/src/audio_loop.js');
        for(const file of ${JSON.stringify(files)}){
            const response=await fetch('./assets/audio/'+file);
            if(!response.ok)throw new Error(file+': '+response.status);
            const buffer=await context.decodeAudioData(await response.arrayBuffer());
            let peak=0,sum=0,nonfinite=0,edge=0;
            for(let c=0;c<buffer.numberOfChannels;c++){
                const samples=buffer.getChannelData(c);
                edge=Math.max(edge,Math.abs(samples[0]),Math.abs(samples.at(-1)));
                for(const x of samples){if(!Number.isFinite(x))nonfinite++;peak=Math.max(peak,Math.abs(x));sum+=x*x;}
            }
            const trim=file==='footstep_gravel_04.ogg'?.22:1;
            const db=x=>20*Math.log10(Math.max(x,1e-12));
            let loop=null;
            if(/wind|rain/.test(file)){
                const blended=blendAmbienceLoop(context,buffer);
                let beforeJump=0,afterJump=0,loopPeak=0;
                for(let c=0;c<buffer.numberOfChannels;c++){
                    const original=buffer.getChannelData(c),samples=blended.getChannelData(c);
                    beforeJump=Math.max(beforeJump,Math.abs(original[0]-original.at(-1)));
                    afterJump=Math.max(afterJump,Math.abs(samples[0]-samples.at(-1)));
                    for(const x of samples)loopPeak=Math.max(loopPeak,Math.abs(x));
                }
                loop={duration:blended.duration,beforeJumpDb:db(beforeJump),afterJumpDb:db(afterJump),peakDb:db(loopPeak)};
                if(loopPeak>peak+1e-6)throw new Error('Loop blend introduced a peak: '+file);
            }
            rows.push({file,channels:buffer.numberOfChannels,sampleRate:buffer.sampleRate,duration:buffer.duration,
                peakDb:db(peak),trimmedPeakDb:db(peak*trim),rmsDb:db(Math.sqrt(sum/(buffer.length*buffer.numberOfChannels))*trim),
                boundaryDb:db(edge*trim),nonfinite,loop});
        }
        return rows;
    })()`);
    if (result.some(r=>r.nonfinite || r.duration<=0 || r.trimmedPeakDb>0)) throw new Error('Invalid or over-range audio: '+JSON.stringify(result));
    await mkdir('artifacts/overhaul',{recursive:true});
    await writeFile('artifacts/overhaul/audio-levels.json',JSON.stringify({method:'Web Audio decoder, 48 kHz; sample peaks, not intersample true peaks or a listening test',assets:result},null,2));
    console.log(`Decoded ${result.length} assets; finite samples, all runtime-trimmed peaks below 0 dBFS.`);
    console.log(JSON.stringify(result.filter(r=>/wind|rain|gravel_04/.test(r.file)),null,2));
} finally { cdp.close(); }
