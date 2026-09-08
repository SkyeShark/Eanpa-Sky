import test from 'node:test';import assert from 'node:assert/strict';
import{fetchAssetBlob}from'../src/asset_blob.js';
test('image fetch recovers from a connection reset but does not retry a missing asset',async()=>{
    let calls=0;const waits=[],blob=new Blob(['image']);
    const result=await fetchAssetBlob('/image.png',{request:async()=>{if(++calls===1)throw new TypeError('Failed to fetch');return{ok:true,blob:async()=>blob}},wait:async ms=>waits.push(ms)});
    assert.equal(result,blob);assert.equal(calls,2);assert.deepEqual(waits,[100]);calls=0;
    await assert.rejects(fetchAssetBlob('/missing.png',{request:async()=>{calls++;return{ok:false,status:404}},wait:async()=>{throw new Error('must not wait')}}),/missing.png: HTTP 404/);
    assert.equal(calls,1);
});
test('repeated server and body failures end after three attempts with the asset URL',async()=>{
    for(const bodyFailure of [false,true]){
        let calls=0;
        await assert.rejects(fetchAssetBlob('/broken.png',{request:async()=>{calls++;return{ok:bodyFailure,status:503,blob:async()=>{throw new Error('body lost')}}},wait:async()=>{}}),/broken.png/);
        assert.equal(calls,3);
    }
});
