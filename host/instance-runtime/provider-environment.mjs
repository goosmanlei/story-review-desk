/** Configuration stores names, never API key values. Codex CLI auth is separate. */
export function providerKeyEnvironment(profile){
 const name=profile?.capabilities?.apiKeyEnvName||'OPENAI_API_KEY';
 if(typeof name!=='string'||!/^[A-Z][A-Z0-9_]{2,127}$/.test(name)||!name.endsWith('_API_KEY'))throw Error('AI密钥环境变量名须为大写字母/数字/下划线，并以 _API_KEY 结尾');
 return name;
}
