declare module "*.wasm" {
  const mod: WebAssembly.Module;
  export default mod;
}
declare module "*.data" {
  const data: ArrayBuffer;
  export default data;
}
declare module "*.tar.gz" {
  const data: ArrayBuffer;
  export default data;
}
