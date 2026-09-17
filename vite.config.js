export default {
  root: 'src',
  build: { outDir: '../dist', emptyOutDir: true },
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  clearScreen: false
}
