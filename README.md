# King's Newsletter — worker

Worker independente em Node.js + Express para executar verificações periódicas e reportar o estado ao painel da newsletter. O intervalo padrão é de 3 horas. O serviço não implementa envio SMTP: o disparo é solicitado à API oficial.

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

O painel atualiza o estado do worker a cada 15 segundos e mostra última execução, próximo disparo, intervalo, uptime, estado das integrações, horário da última execução bem-sucedida, falhas consecutivas, duração da última tentativa e histórico das últimas 50 execuções. As métricas e o histórico são mantidos em memória e reiniciam quando o processo é reiniciado; não são persistidos no banco de dados. Usuários autenticados podem definir uma data e horário específicos para a próxima execução. A data deve estar no futuro e dentro dos próximos 366 dias, e o agendador precisa estar ativo. Após essa execução, o agendamento retorna ao intervalo automático configurado.

A alteração manual do próximo disparo é mantida apenas na memória do processo: será perdida se o worker reiniciar ou se o agendamento for pausado. Ela não persiste a configuração no site, não altera a API da newsletter e não dispara e-mails imediatamente. Datas e horários são exibidos no fuso `America/Rio_Branco`.

## Agendamento e operação

Quando o controle remoto está configurado, a configuração salva no site prevalece para habilitar/pausar o worker e definir o intervalo automático. O processo precisa permanecer ativo para executar as verificações. O agendador impede sobreposição dentro deste processo. Para múltiplas instâncias, implemente um lock distribuído ou fila antes de escalar.

## Retry e segurança

O cliente implementa retry limitado para falhas transitórias e `Retry-After`, sem repetir erros HTTP permanentes. Não registre tokens, cabeçalhos de autenticação ou corpos integrais de respostas. Restrinja o acesso às portas conforme o ambiente de hospedagem.
