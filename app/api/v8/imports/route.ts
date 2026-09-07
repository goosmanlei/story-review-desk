// An import is a candidate AssetVersionEvent registration. Keeping one implementation
// prevents the upload/registration entry point from weakening lineage or review gates.
export { GET, POST } from '../asset-versions/route';
