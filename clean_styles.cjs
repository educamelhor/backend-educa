const fs = require('fs');

const cleanStyle = (path, searchStr) => {
  let content = fs.readFileSync(path, 'utf8');
  let loopCount = 0;
  while (content.includes(searchStr) && loopCount < 10) {
    const s = content.indexOf(searchStr);
    const end = content.indexOf('}}', s);
    if (end > s) {
      content = content.slice(0, s) + content.slice(end + 2);
    }
    loopCount++;
  }
  fs.writeFileSync(path, content);
};

// AgentePlanos
const p1 = 'C:/projetos/PRODUCAO/frontend-educa/src/features/agente-educa/AgentePlanos.jsx';
cleanStyle(p1, 'style={{\n                  display: "flex", alignItems: "center", gap: 10,');
cleanStyle(p1, 'style={{\n                  display: "flex", alignItems: "center", gap: 8,');

// AgenteNotas
const p2 = 'C:/projetos/PRODUCAO/frontend-educa/src/features/agente-educa/AgenteNotas.jsx';
cleanStyle(p2, 'style={{\n                  display: "flex", alignItems: "center", gap: 10,');
cleanStyle(p2, 'style={{\n                  display: "flex", alignItems: "center", gap: 8,');

console.log('Styles cleaned!');
