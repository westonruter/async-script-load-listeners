document.getElementById( 'output' ).textContent += 'Async script evaluated\n';

window.myAsyncFunc = function ( source ) {
  document.getElementById( 'output' ).textContent += `Async script\'s function called by ${source}\n`;
}