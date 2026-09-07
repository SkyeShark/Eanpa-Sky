import {readPng} from './png-data.mjs';
const h=await readPng('assets/ringworld/ring_band_height.png');
const n=await readPng('assets/ringworld/ring_band_normal_v2.png');
const results={height:[h.width,h.height,h.channels],normal:[n.width,n.height,n.channels]};
let xx=0,yy=0,dxn=0,dyn=0;
for(let y=1;y<h.height-1;y+=3)for(let x=1;x<h.width-1;x+=3){
    const i=y*h.width+x,dx=(h.data[(i+1)*h.channels]-h.data[(i-1)*h.channels])/510,dy=(h.data[(i+h.width)*h.channels]-h.data[(i-h.width)*h.channels])/510;
    const z=Math.max(.1,n.data[i*n.channels+2]/127.5-1);
    xx+=dx*dx;yy+=dy*dy;dxn+=dx*(n.data[i*n.channels]/127.5-1)/z;dyn+=dy*(n.data[i*n.channels+1]/127.5-1)/z;
}
results.normalSlopeScale=[dxn/xx,dyn/yy];console.log(results);
