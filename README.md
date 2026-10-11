# King's Newsletter — worker

Worker independente em Node.js + Express para executar verificações periódicas e reportar o estado ao painel da newsletter. O intervalo padrão é de 3 horas. O serviço não implementa envio SMTP: o disparo é solicitado à API oficial.

## Requisitos e início

- Node.js 20 ou superior
- Copie `.env.example` para `.env` e preencha os valores necessários.
- `npm install`
- `npm test`
- `npm start`

O health check fica em `GET /health`. Se `PORT` estiver definida pela hospedagem, o worker usa essa porta; se estiver vazia, usa uma porta dinâmica. `HOST` é opcional: quando não definido, o Node.js escolhe o endereço de escuta padrão do ambiente. Não configure `HOST=localhost` em uma hospedagem que precise receber conexões externas. Configure `SCHEDULER_ENABLED=false` para manter o processo sem agendador.

## Integração com a newsletter

Defina `NEWSLETTER_API_BASE_URL` com a URL pública do site e `NEWSLETTER_API_TOKEN` com o valor de `NOTIFY_SECRET`, guardado como segredo local. O exemplo usa `POST /api/notify-news`. O token segue no cabeçalho Bearer. Nunca coloque segredos no repositório. A resposta é registrada sem imprimir o corpo integral.

## Controle remoto do agendamento

Configure `WORKER_CONTROL_SECRET` no worker e no ambiente do site com o mesmo valor aleatório de pelo menos 32 caracteres. Esse segredo é separado de `NEWSLETTER_API_TOKEN`/`NOTIFY_SECRET`: ele autentica a leitura das configurações e o envio de heartbeats.

O worker consulta a configuração a cada 30 segundos e envia um heartbeat com o estado e a próxima execução. O painel do site permite escolher um intervalo inteiro de 1 a 168 horas e pausar ou retomar o agendamento. O worker inicia as conexões HTTPS; não é necessário que o site abra uma conexão de entrada para o worker.

## Monitor web do worker

A página fica em `/monitor` no host onde o worker está hospedado. Ela é somente de leitura e mostra o estado do processo, intervalo, última/próxima execução, resultado da última chamada à API e falhas de sincronização com o painel. Os dados são atualizados a cada 15 segundos. `/monitor/status` fornece os dados usados pela página.

Para habilitá-la, configure estas variáveis no ambiente da hospedagem do worker:

- `MONITOR_USERNAME`: usuário de acesso.
- `MONITOR_PASSWORD`: senha forte e exclusiva.

Se alguma delas estiver vazia, as rotas `/monitor` e `/monitor/status` respondem 404. Com as credenciais configuradas, ambas exigem autenticação HTTP Basic. Use HTTPS na hospedagem e não reutilize a senha de `WORKER_CONTROL_SECRET` ou `NEWSLETTER_API_TOKEN`. O monitor não acessa MongoDB, não altera a API da newsletter e não dispara e-mails.

## Agendamento e operação

Quando o controle remoto está configurado, a configuração salva no site prevalece. O processo precisa permanecer ativo para executar as verificações. Datas do monitor são exibidas no fuso `America/Rio_Branco`; a API interna retorna datas ISO 8601.

O agendador impede sobreposição dentro deste processo. Para múltiplas instâncias, implemente um lock distribuído ou fila antes de escalar.

## Retry e segurança

O cliente implementa retry limitado para falhas transitórias e `Retry-After`, sem repetir erros HTTP permanentes. Não registre tokens, cabeçalhos de autenticação ou corpos integrais de respostas. Restrinja o acesso às portas conforme o ambiente de hospedagem.
