const fs = require('fs');
const p = 'C:/projetos/PRODUCAO/frontend-educa/src/features/agente-educa/AgentePlanos.jsx';
let content = fs.readFileSync(p, 'utf8');

const sIdx1 = content.indexOf('{[');
const eIdx1 = content.indexOf('</div>', sIdx1);

// A simple manual replacement
const newContent1 = `{[
            { key: "todos",      label: \`Todos\`,      count: planosPorBimestre.length },
            { key: "prontos",    label: \`Prontos\`,    count: totalProntos },
            { key: "exportados", label: \`Exportados\`, count: totalExportados },
          ].map(f => (
            <button
              key={f.key}
              onClick={() => setFiltro(f.key)}
              className={\`premium-pill-btn \${filtro === f.key ? 'active' : ''}\`}
            >
              {f.label}
              <span className="badge">{f.count}</span>
            </button>
          ))}`;

content = content.replace(/\{\[\s*\{\s*key:\s*"todos",\s*label:\s*`Todos`[\s\S]*?\}\)\)/g, newContent1);

const newContent2 = `{[
            { key: "todos", label: "Todos os Bimestres", short: "Todos", color: "#6366f1", total: planosComBimestral.length },
            { key: "1",     label: "1º Bimestre",         short: "1º Bim", color: "#6366f1", total: contagemPorBim["1"] || 0 },
            { key: "2",     label: "2º Bimestre",         short: "2º Bim", color: "#8b5cf6", total: contagemPorBim["2"] || 0 },
            { key: "3",     label: "3º Bimestre",         short: "3º Bim", color: "#ec4899", total: contagemPorBim["3"] || 0 },
            { key: "4",     label: "4º Bimestre",         short: "4º Bim", color: "#f59e0b", total: contagemPorBim["4"] || 0 },
          ].map(b => {
            const ativo = filtroBimestre === b.key;
            return (
              <button
                key={b.key}
                onClick={() => setFiltroBimestre(b.key)}
                className={\`premium-pill-btn premium-pill-sm \${ativo ? 'active' : ''}\`}
                title={b.label}
              >
                {b.short}
                <span className="badge" style={ativo ? {} : { opacity: b.total === 0 ? 0.3 : 1 }}>
                  {b.total}
                </span>
              </button>
            );
          })}`;

content = content.replace(/\{\[\s*\{\s*key:\s*"todos",\s*label:\s*"Todos os Bimestres"[\s\S]*?\}\)\}/g, newContent2);

fs.writeFileSync(p, content);
console.log('done');
