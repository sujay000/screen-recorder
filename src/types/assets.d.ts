// WGSL shaders are bundled as text by esbuild.
declare module '*.wgsl' {
  const source: string;
  export default source;
}
