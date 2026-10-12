# Local graph layout runtime

`viz-3.31.0.js` is the unmodified browser UMD distribution of [@viz-js/viz 3.31.0](https://www.npmjs.com/package/@viz-js/viz/v/3.31.0). It bundles Graphviz 16.1.0 and Expat 2.8.5 as WebAssembly. The application loads it inside its local graph worker; no graph data is sent to an external service and no CDN is used.

- Upstream archive: `https://registry.npmjs.org/@viz-js/viz/-/viz-3.31.0.tgz`
- Archive integrity: `sha512-r7zlQdRvcwvIpjHGgs+KNWHeE/P5/Dq7k8ZAKaMCbZqomxCBJV78gVuQYaHzFVca+kB0mX0fMW9UFevCOBG50A==`
- Distributed JavaScript SHA-256: `c9e0b310f9883910e01c66054b48b7ff4be3d8695141116635e72b0af152692e`
- Viz source commit: `c8ce050d28eb0dc1ed1629ea32ab7f3dc117db0f` ([source](https://github.com/mdaines/viz-js/tree/c8ce050d28eb0dc1ed1629ea32ab7f3dc117db0f)).
- Graphviz source: [16.1.0](https://gitlab.com/graphviz/graphviz/-/tree/16.1.0).
- Expat source: [R_2_8_5](https://github.com/libexpat/libexpat/tree/R_2_8_5).

The original notices are preserved beside the distribution: [Viz MIT](VIZ-LICENSE), [Graphviz EPL-2.0](GRAPHVIZ-LICENSE), and [Expat MIT](EXPAT-LICENSE). Upgrades must replace the versioned file and notices together, verify archive integrity, and rerun the geometry and browser checks; the stored version is deliberate.
