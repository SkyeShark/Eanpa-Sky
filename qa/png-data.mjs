// Minimal lossless PNG reader for numerical source maps used by the asset bake.
import {readFile} from 'node:fs/promises';
import {inflateSync} from 'node:zlib';
export async function readPng(path){
    const input=await readFile(path);
    if(input.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw new Error('Not a PNG');
    let width,height,channels,bytesPerChannel;const chunks=[];
    for(let p=8;p<input.length;){
        const length=input.readUInt32BE(p),type=input.toString('ascii',p+4,p+8),data=input.subarray(p+8,p+8+length);
        if(type==='IHDR'){
            width=data.readUInt32BE(0);height=data.readUInt32BE(4);
            channels=({0:1,2:3,4:2,6:4})[data[9]];
            bytesPerChannel=data[8]/8;
            if(![1,2].includes(bytesPerChannel)||!channels||data[12]!==0)throw new Error('Expected non-interlaced 8/16-bit data PNG');
        }else if(type==='IDAT')chunks.push(data);
        p+=length+12;
    }
    const scan=inflateSync(Buffer.concat(chunks)),pixelBytes=channels*bytesPerChannel,stride=width*pixelBytes;
    const pixels=new Uint8Array(stride*height);
    const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
    for(let y=0;y<height;y++){
        const filter=scan[y*(stride+1)];
        if(filter>4)throw new Error('Invalid PNG row filter');
        for(let x=0;x<stride;x++){
            const i=y*stride+x,a=x>=pixelBytes?pixels[i-pixelBytes]:0,b=y?pixels[i-stride]:0,c=y&&x>=pixelBytes?pixels[i-stride-pixelBytes]:0;
            const prediction=[0,a,b,Math.floor((a+b)/2),paeth(a,b,c)][filter];
            pixels[i]=(scan[y*(stride+1)+x+1]+prediction)&255;
        }
    }
    let data=pixels;
    if(bytesPerChannel===2){
        data=new Float32Array(pixels.length/2);
        for(let i=0;i<data.length;i++)data[i]=((pixels[2*i]<<8)|pixels[2*i+1])/257;
    }
    return {width,height,channels,data};
}
