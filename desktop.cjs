'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const EXECUTABLE=/\.(?:exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msc|scr|pif|cpl|msi|msp|lnk|url|reg|hta)$/i;
async function validateOpenPath(filename){
 if(typeof filename!=='string'||!path.isAbsolute(filename)||filename.includes('\0')||/^\\\\/.test(filename))throw Error('Elegí un archivo o una carpeta de tu computadora.');
 const stat=await fs.lstat(filename);if(stat.isSymbolicLink()||!stat.isFile()&&!stat.isDirectory())throw Error('No se puede abrir ese tipo de archivo.');
 if(stat.isFile()&&EXECUTABLE.test(filename))throw Error('Para ejecutar este archivo, usá la consola.');
 return path.resolve(filename);
}
function desktopTools(shell,{getLanguage=()=> 'es'}={}){return{async openPath(filename){try{const target=await validateOpenPath(filename);const error=await shell.openPath(target);if(error)throw Error('No se pudo abrir. Comprobá que tengas una aplicación para este archivo.');return true;}catch(error){if(getLanguage()!=='en')throw error;const messages={'Elegí un archivo o una carpeta de tu computadora.':'Choose a file or folder on your computer.','No se puede abrir ese tipo de archivo.':'This type of file cannot be opened here.','Para ejecutar este archivo, usá la consola.':'Use the console to run this file.','No se pudo abrir. Comprobá que tengas una aplicación para este archivo.':'Could not open the file. Check that you have an app that can open it.'};throw Error(messages[error.message]||'Could not open the file. Check that it still exists.');}}};}
module.exports={desktopTools,validateOpenPath};
