# King's Worker

Serviço 24/7 do King's Newsletter, em Node.js + Express, que executa as tarefas agendadas de todos os projetos:

- **Newsletter:** verifica periodicamente e solicita o disparo à API oficial do site, reportando o estado ao painel. O intervalo padrão é de 3 horas. O worker não implementa envio SMTP.
- **King's Sports:** faz toda a coleta de dados, inclusive o placar ao vivo a cada 15 segundos (veja [Coleta do King's Sports](#coleta-do-kings-sports)).

Um monitor web protegido por login mostra o estado de cada tarefa.

## Requisitos e início

- Node.js 20 ou superior
- Copie `.env.example` para `.env` e preencha os valores necessários.
- `npm install`
- `npm test`
- `npm start`

O health check fica em `GET /health`. Se `PORT` estiver definida pela hospedagem, o worker usa essa porta; se estiver vazia, usa uma porta dinâmica. `HOST` é opcional: quando não definido, o Node.js escolhe o endereço de escuta padrão do ambiente. Configure `SCHEDULER_ENABLED=false` para manter o processo sem agendador.

## Integração com a newsletter

Defina `NEWSLETTER_API_BASE_URL` com a URL pública do site e `NEWSLETTER_API_TOKEN` com o valor de `NOTIFY_SECRET`, guardado como segredo local. O exemplo usa `POST /api/notify-news`. O token segue no cabeçalho Bearer. Nunca coloque segredos no repositório. A resposta é registrada sem imprimir o corpo integral.

## Controle remoto do agendamento

Configure `WORKER_CONTROL_SECRET` no worker e no ambiente do site com o mesmo valor aleatório de pelo menos 32 caracteres. Esse segredo é separado de `NEWSLETTER_API_TOKEN`/`NOTIFY_SECRET`: ele autentica a leitura das configurações e o envio de heartbeats.

O worker consulta a configuração a cada 30 segundos e envia um heartbeat com o estado e a próxima execução. O painel do site permite escolher um intervalo inteiro de 1 a 168 horas e pausar ou retomar o agendamento. O worker inicia as conexões HTTPS; não é necessário que o site abra uma conexão de entrada para o worker.

## Monitor web do worker

A página fica em `/monitor` no host onde o worker está hospedado. Configure `MONITOR_USERNAME` e `MONITOR_PASSWORD` nas variáveis de ambiente para habilitá-la. O painel apresenta uma tela de login própria; as sessões usam cookies `HttpOnly`, `SameSite=Strict` e expiram após 8 horas. Use HTTPS na hospedagem e uma senha exclusiva. Se as credenciais não estiverem configuradas, as rotas do monitor ficam desabilitadas.

O painel atualiza o estado do worker a cada 15 segundos e mostra última execução, próximo disparo, intervalo, uptime, estado das integrações, horário da última execução bem-sucedida, falhas consecutivas, duração da última tentativa e as últimas 50 execuções. As métricas e o histórico são persistidos no banco SQLite local e permanecem disponíveis após reinícios. Usuários autenticados podem definir uma data e horário específicos para a próxima execução. A data deve estar no futuro e dentro dos próximos 366 dias, e o agendador precisa estar ativo. Após essa execução, o agendamento retorna ao intervalo automático configurado.

O horário personalizado do próximo disparo é persistido no banco SQLite local e restaurado após reinícios, desde que ainda esteja no futuro. Um horário vencido durante a indisponibilidade é ignorado e o worker agenda a próxima execução automática a partir da retomada. Pausar o agendador limpa o próximo horário pendente. A configuração local não altera a API da newsletter e não dispara e-mails imediatamente. Datas e horários são exibidos no fuso `America/Rio_Branco`.

## Banco de dados local

O worker usa SQLite por meio de `sql.js`, sem exigir um processo de banco separado ou compilação de módulos nativos. O arquivo padrão é `data/worker.db`, relativo ao diretório de trabalho; configure `WORKER_DB_PATH=/app/data/worker.db` no Shardcloud caso o diretório de execução seja diferente. O arquivo é criado automaticamente e não deve ser versionado.

As configurações do agendador, o último estado de saúde e o histórico das execuções ficam nesse arquivo. O histórico é retido por 90 dias por padrão; ajuste `WORKER_HISTORY_RETENTION_DAYS` entre 1 e 3650 dias. O painel exibe as 50 execuções mais recentes.

A hospedagem precisa manter o arquivo em disco persistente. Esta configuração é destinada a uma única instância do worker: não compartilhe o mesmo arquivo SQLite entre réplicas. Mantenha backups do arquivo se precisar recuperar o histórico após exclusão acidental.

## Coleta do King's Sports

Toda a coleta de dados do King's Sports roda neste worker: placar ao vivo, jogos e tabelas, escudos e calendário da temporada. O portal só lê do MongoDB e não executa coleta nem cron na Vercel.

A coleta fica em `src/sports/` e grava na coleção `sports` do mesmo banco da newsletter. Cada documento é separado por um campo `type`. A coleta nunca lê nem escreve nas coleções da newsletter.

| Job | Quando roda | O que faz |
| --- | --- | --- |
| `live` | A cada `SPORTS_LIVE_EVERY_SEC` (15 s) | Atualiza placar e relógio. Só chama um provedor quando há jogo em andamento ou prestes a começar. |
| `daily` | Ao iniciar e a cada 30 min, se a última execução tiver mais de 12 h | Jogos de ontem até sete dias à frente, tabelas e estatísticas de todas as ligas, além da Fórmula 1. |
| `crests` | Logo depois de cada `daily` | Escudos que faltam (TheSportsDB). |
| `season` | A cada 2 min | Calendário da temporada de cada liga, renovado uma vez por semana. Para em cerca de 45 s e continua na execução seguinte. |

O `live` tem trava própria e nunca espera os jobs longos. `daily`, `crests` e `season` dividem outra trava, então não rodam ao mesmo tempo. Uma falha no Sports não afeta o agendador da newsletter.

Para ligar, defina `SPORTS_INGEST_ENABLED=true` e `MONGODB_URI`. O estado de cada job aparece na página **Coleta do Sports** do monitor.

### Fontes de dados

| Provedor | Uso | Chave |
| --- | --- | --- |
| ESPN | Fonte principal: placares, calendários, tabelas e estatísticas | Não exige |
| SportAPI | Reserva para futebol e NBA | `SPORTAPI_KEY` (opcional) |
| OpenF1 e Jolpica | Fórmula 1 | Não exigem |
| TheSportsDB | Escudos que faltam | Chave pública por padrão |

As chamadas de cada provedor são contadas no MongoDB e respeitam tetos diários e mensais (veja `.env.example`). Ao alterar as competições acompanhadas, atualize `src/sports/catalog.js` e o `lib/catalog.ts` do portal juntos: o worker usa o catálogo para saber o que coletar, e o portal, para exibir.

### Uma instância só

As travas valem dentro de um processo. Rode uma única instância do worker com a coleta ligada; duas instâncias fariam chamadas duplicadas aos provedores.

## Agendamento e operação

Quando o controle remoto está configurado, a configuração salva no site prevalece para habilitar/pausar o worker e definir o intervalo automático. O processo precisa permanecer ativo para executar as verificações. O agendador impede sobreposição dentro deste processo. Para múltiplas instâncias, implemente um lock distribuído ou fila antes de escalar.

## Retry e segurança

O cliente implementa retry limitado para falhas transitórias e `Retry-After`, sem repetir erros HTTP permanentes. Não registre tokens, cabeçalhos de autenticação ou corpos integrais de respostas. Restrinja o acesso às portas conforme o ambiente de hospedagem.
