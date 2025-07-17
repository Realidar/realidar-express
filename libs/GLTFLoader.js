THREE.GLTFLoader = function ( manager ) {
    this.manager = ( manager !== undefined ) ? manager : THREE.DefaultLoadingManager;
};

THREE.GLTFLoader.prototype = {

    load: function ( url, onLoad, onProgress, onError ) {
        const loader = new THREE.FileLoader( this.manager );
        loader.setResponseType( 'arraybuffer' );
        loader.load( url, function ( data ) {
            try {
                THREE.GLTFLoaderUtils.parse( data, onLoad );
            } catch ( error ) {
                if ( onError ) onError( error );
            }
        }, onProgress, onError );
    }

};

// NOTA: para esta versión demo básica, esto es suficiente.
// En producción deberías usar el archivo completo desde https://github.com/mrdoob/three.js/blob/dev/examples/js/loaders/GLTFLoader.js
