const fs = require('fs');
const p = 'C:/projetos/PRODUCAO/frontend-educa/src/features/agente-educa/AgenteNotas.jsx';
let content = fs.readFileSync(p, 'utf8');

const regex1 = /\{\[\s*\{\s*key:\s*"todos",\s*label:\s*"Todos"[^]*?\}\)\)/;
content = content.replace(regex1, `{[
              { key: "todos",      label: "Todos",      count: planosPorBimestre.length },
              { key: "prontos",    label: "Prontos",    count: planosProntos.length },
              { key: "exportados", label: "Exportados", count: planosExportados.length },
            ].map(f => (
              <button
                key={f.key}
                onClick={() => setFiltro(f.key)}
                className={\`premium-pill-btn premium-pill-btn-green \${filtro === f.key ? 'active' : ''}\`}
              >
                {f.label}
                <span className="badge">{f.count}</span>
              </button>
            ))`);

const regex2 = /\{\[\s*\{\s*key:\s*"todos",\s*label:\s*"Todos os Bimestres"[^]*?\}\)\}/;
content = content.replace(regex2, `{[
              { key: "todos", label: "Todos os Bimestres", short: "Todos", color: "#10b981", total: planosValidos.length },
              { key: "1",     label: "1º Bimestre",         short: "1º Bim", color: "#10b981", total: contagemPorBim["1"] || 0 },
              { key: "2",     label: "2º Bimestre",         short: "2º Bim", color: "#059669", total: contagemPorBim["2"] || 0 },
              { key: "3",     label: "3º Bimestre",         short: "3º Bim", color: "#047857", total: contagemPorBim["3"] || 0 },
              { key: "4",     label: "4º Bimestre",         short: "4º Bim", color: "#064e3b", total: contagemPorBim["4"] || 0 },
            ].map(b => {
              const ativo = filtroBimestre === b.key;
              return (
                <button
                  key={b.key}
                  onClick={() => setFiltroBimestre(b.key)}
                  className={\`premium-pill-btn premium-pill-btn-green premium-pill-sm \${ativo ? 'active' : ''}\`}
                  title={b.label}
                >
                  {b.short}
                  <span className="badge" style={ativo ? {} : { opacity: b.total === 0 ? 0.3 : 1 }}>
                    {b.total}
                  </span>
                </button>
              );
            })}`);

fs.writeFileSync(p, content);
console.log('done');
