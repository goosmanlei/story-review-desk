import { check, identity } from '../shared/contracts.mjs';

export const libraryKinds = ['REVIEW_LIBRARY_SYNC', 'REVIEW_LIBRARY_VERIFY'];
export const LIBRARY_FORMAT = 1;
export function libraryPath(value) {
  check(typeof value === 'string' && value.length <= 600 &&
    /^(texts|images|audio|videos|other)\/[a-z0-9][a-z0-9./_-]*$/.test(value) &&
    value.split('/').every(part => part && part !== '.' && part !== '..' && part.length <= 160),
  'LIBRARY_PATH', '审阅路径须为安全的 ASCII 相对路径');
  return value;
}
export function validateLibrary(value) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'LIBRARY_CONFIGURATION', '审阅目录配置无效');
  check(Object.keys(value).every(k => ['enabled', 'texts'].includes(k)), 'LIBRARY_CONFIGURATION', '审阅目录包含未知配置');
  check(value.enabled === undefined || typeof value.enabled === 'boolean', 'LIBRARY_CONFIGURATION', 'enabled 须为布尔值');
  check(Array.isArray(value.texts) && value.texts.length <= 100, 'LIBRARY_CONFIGURATION', '文本须为明确选择的有界清单');
  const paths = new Set();
  for (const text of value.texts) {
    check(text && Object.keys(text).every(k => ['kind', 'objectId', 'revisionId', 'path'].includes(k)), 'LIBRARY_CONFIGURATION', '文本选择包含未知字段');
    check(['source', 'screenplay'].includes(text.kind), 'LIBRARY_CONFIGURATION', '文本类型无效');
    identity(text.objectId);
    if (text.revisionId) identity(text.revisionId);
    libraryPath(text.path);
    check(text.path.startsWith('texts/') && text.path.endsWith('.md') && !paths.has(text.path), 'LIBRARY_CONFIGURATION', '文本路径须为不同的 Markdown 文件');
    paths.add(text.path);
  }
  return value;
}
