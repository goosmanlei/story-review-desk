import type { NextConfig } from 'next';

const rawBasePath = (process.env.REVIEW_BASE_PATH || '').trim();
const basePath = !rawBasePath || rawBasePath === '/' ? '' : rawBasePath.replace(/\/$/, '');
if (basePath && (!/^\/[A-Za-z0-9][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9][A-Za-z0-9._~-]*)*$/.test(basePath) || basePath.includes('//'))) {
  throw new Error('REVIEW_BASE_PATH must be empty or an absolute URL path without a trailing slash');
}

const nextConfig: NextConfig = {
  basePath,
  env: { NEXT_PUBLIC_REVIEW_BASE_PATH: basePath },
};

export default nextConfig;
