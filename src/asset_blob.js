// A transient connection reset while loading one of many parallel images
// should not strand the boot sequence. Permanent HTTP failures stay explicit.
export async function fetchAssetBlob(url,{request=fetch,wait=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
    for(let attempt=0;attempt<3;attempt++){
        let response;
        try{
            response=await request(url);
            if(response.ok)return await response.blob();
        }catch(error){
            if(attempt===2||error.name==='AbortError')throw new Error(`Unable to load image ${url}`,{cause:error});
        }
        if(response&&!response.ok&&(response.status<500||attempt===2))throw new Error(`Image ${url}: HTTP ${response.status}`);
        await wait(100*(attempt+1));
    }
}
