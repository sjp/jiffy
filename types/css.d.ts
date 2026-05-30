// CSS files are loaded as raw text (esbuild `text` loader) so their contents can
// be fed to an adopted stylesheet inside the shadow root (PRD §7).
declare module '*.css' {
  const content: string;
  export default content;
}
