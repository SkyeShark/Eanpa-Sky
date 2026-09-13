// Downloads never mutate live bindings. The serialized frame loop uploads one
// array per frame, then publishes the complete pair at a frame boundary.
export function makeProgressiveTextures({textures, nodes, load, upload, onPublish = () => {}}) {
    const keys = Object.keys(textures);
    const stats = {state: 'preview', uploaded: 0, error: null};
    let pending = null, disposed = false;
    const release = set => { for (const texture of Object.values(set ?? {})) texture.dispose(); };
    return {
        stats,
        update() {
            if (disposed) return false;
            if (stats.state === 'preview') {
                stats.state = 'loading';
                Promise.resolve().then(load).then(result => {
                    if (disposed) { release(result); return; }
                    pending = result;
                    stats.state = 'uploading';
                }).catch(error => {
                    if (!disposed) { stats.state = 'failed'; stats.error = String(error.message ?? error); }
                });
            } else if (stats.state === 'uploading') {
                try {
                    upload(pending[keys[stats.uploaded]]);
                    stats.uploaded++;
                    if (stats.uploaded === keys.length) stats.state = 'ready';
                } catch (error) {
                    release(pending); pending = null;
                    stats.state = 'failed'; stats.error = String(error.message ?? error);
                }
            } else if (stats.state === 'ready') {
                const previous = {...textures};
                for (const key of keys) {
                    textures[key] = pending[key];
                    nodes[key].value = pending[key];
                }
                pending = null; stats.state = 'complete';
                release(previous);
                onPublish();
                return true;
            }
            return false;
        },
        dispose() {
            if (disposed) return;
            disposed = true; stats.state = 'disposed';
            release(pending); pending = null;
            release(textures);
        },
    };
}
