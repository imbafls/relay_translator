/** unbzip2-stream ships no types; it is a plain transform stream factory. */
declare module "unbzip2-stream" {
  import { Transform } from "stream";
  function unbzip2Stream(): Transform;
  export = unbzip2Stream;
}
