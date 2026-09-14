# Terminal width dependency

The standard project installs its CLI source without node_modules. These MIT implementations travel with the CLI to keep task management self-contained. Only import specifiers and file extensions changed; width behavior is upstream behavior. The development dependency string-width pins the original dependency tree and provides the independent test oracle.

To refresh, install the pinned tree, copy the files below, replace imports with the matching local .mjs filenames, retain all four licenses, and run the isolated installed-CLI and terminal-format tests.

{
  "packages": [
    {
      "name": "string-width",
      "version": "8.2.2"
    },
    {
      "name": "strip-ansi",
      "version": "7.2.0"
    },
    {
      "name": "ansi-regex",
      "version": "6.3.0"
    },
    {
      "name": "get-east-asian-width",
      "version": "1.6.0"
    }
  ],
  "files": [
    {
      "source": "string-width/index.js",
      "target": "string-width.mjs",
      "sha256": "60c197f20cc966a2ede2dfec1ad4b764aa4095a43d225792b2652bca6afeb21b"
    },
    {
      "source": "strip-ansi/index.js",
      "target": "strip-ansi.mjs",
      "sha256": "9ff7e1abf2727fbf9854a9dfcc1e69d1f9a0b23ccc0649269fc1c4fa8e44bd79"
    },
    {
      "source": "ansi-regex/index.js",
      "target": "ansi-regex.mjs",
      "sha256": "2a559673ea6761000b019f83b538a6912cc11d62c72c192c8edea0ced9c77973"
    },
    {
      "source": "get-east-asian-width/index.js",
      "target": "east-asian-width.mjs",
      "sha256": "d7b1ba05914c0fc311c20e5618bf8d0893c9c74078a07975e2df981445e64887"
    },
    {
      "source": "get-east-asian-width/lookup.js",
      "target": "east-asian-lookup.mjs",
      "sha256": "c80ecc22b120b27ef5ea9facb7000b8fd4ec037a84d9231d215f1c44bc9c21d0"
    },
    {
      "source": "get-east-asian-width/lookup-data.js",
      "target": "east-asian-lookup-data.mjs",
      "sha256": "f6b40f86c9a2a6808ec808fa8ddcb8da261254cc6121d37ffaeb2bf35dad1d5b"
    },
    {
      "source": "get-east-asian-width/utilities.js",
      "target": "east-asian-utilities.mjs",
      "sha256": "4b08a7e9e3ffacbcf198a6abceb2338d52ac671899e52ccc2851c898bfccac42"
    }
  ]
}
