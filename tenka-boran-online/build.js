'use strict';
// Claudeで作ったゲーム画面(sengoku-satsu.html)から、公開用の public/index.html を作る
const fs = require('fs'); const path = require('path');
const src = process.argv[2] || path.join(__dirname, '..', 'sengoku-satsu.html');
let body = fs.readFileSync(src, 'utf8');
const head = [];
body = body.replace(/<title>[\s\S]*?<\/title>\n?/, m => { head.push(m.trim()); return ''; });
body = body.replace(/<meta name="claude:[^>]*>\n?/, '');
body = body.replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>\n?/, m => { head.push(m.trim()); return ''; });
const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="description" content="戦国武将が身分を隠して戦う、裏切りと推理の合戦カードゲーム。友達と最大5人でオンライン対戦。">
<meta property="og:title" content="戦国 天下謀乱">
<meta property="og:description" content="謀反人は誰だ。友達と遊べる戦国身分推理カードゲーム。">
<meta property="og:image" content="/img/title.webp">
${head.join('\n')}
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>
</head>
<body>
${body}
</body>
</html>
`;
fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'public', 'index.html'), html);
console.log('public/index.html を作成しました');
