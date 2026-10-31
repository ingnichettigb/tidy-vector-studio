# Tidy Vector Studio

pulizia DWG

Crea un'applicazione SaaS per la visualizzazione e la modifica leggera di file CAD vettoriali orientata alla massima semplicità d'uso. L'applicazione deve simulare un ambiente CAD moderno ma minimale. L'interfaccia utente deve essere divisa in tre macro-aree principali disposte in questo modo:

1. LINEA COMANDI (In Alto)
- Posiziona una barra orizzontale fissa nella parte superiore dello schermo che agisce da "Linea di Comando" (Command Line), simile ai software CAD tradizionali.
- Mostra uno storico degli ultimi 2-3 comandi eseguiti (es. "Rettangolo creato", "Elemento eliminato") e un campo di testo di input attivo dove l'utente può digitare comandi testuali veloci (es. digitando "canc" o "linea").

2. AREA DI DISEGNO CENTRALE (Canvas) con CONTROLLI DI NAVIGAZIONE ai lati
- La parte centrale deve essere un grande Canvas interattivo (utilizza una libreria open-source come Fabric.js o simili all'interno di React/Tailwind) per mostrare il disegno vettoriale.
- AI LATI DEL CANVAS inserisci controlli galleggianti o barre laterali dedicate alla navigazione del file:
  * Pulsanti di ZOOM (+ / - / Zoom Estensione per centrare il disegno).
  * Pulsante PAN (una modalità "Mano" per spostarsi e trascinare il disegno all'interno del foglio senza modificarlo).

3. STRUMENTI DI MODIFICA MINIMA (Barra degli strumenti laterale o contestuale)
L'applicazione deve permettere esclusivamente queste modifiche mirate su base vettoriale gratuita:
- SELEZIONE E CANCELLAZIONE: Cliccando su qualsiasi testo o linea esistente sul disegno, l'elemento deve evidenziarsi. Se l'utente preme il tasto "Canc" o clicca sull'icona del cestino, l'elemento viene eliminato.
- INSERIMENTO GEOMETRIE: Pulsanti dedicati per inserire Nuove Linee e Nuovi Rettangoli tramite click e trascinamento del mouse (Click & Drag).
- PALETTE 5 COLORI: Inserisci un selettore di colore con esattamente 5 opzioni pronte (Nero, Rosso, Blu, Verde, Giallo). Quando si inserisce una nuova linea o rettangolo, questo prenderà il colore selezionato dalla palette.

GESTIONE DEI FORMATI E ARCHITETTURA FREE (Simulazione Frontend)
- Configura una schermata iniziale o un'area di "Dropzone" in cui l'utente può trascinare un file .DWG o .DXF.
- Simula il processo backend nel frontend per questa fase di MVP: quando l'utente carica un file, simula una conversione gratuita server-side (es. DWG -> DWF/SVG) mostrando un loader, per poi renderizzare il disegno convertito in vettori SVG manipolabili all'interno del Canvas di Fabric.js.
- Aggiungi un pulsante "Esporta/Salva" che permette di scaricare il disegno modificato in formato DXF standard (generato virtualmente dal backend).

DESIGN E LOGICA DI SISTEMA
- Stile grafico moderno, pulito, tema scuro per l'area di disegno (stile AutoCAD/Editor tecnico) e controlli ad alto contrasto.
- Usa dati mock (un disegno CAD di esempio con qualche muro, testi e quote) pre-caricati all'avvio dell'app così da poter testare subito lo zoom, il pan, la cancellazione dei testi e il disegno di rettangoli colorati.

Procedi alla creazione della struttura dell'interfaccia, dei componenti di navigazione e della logica del canvas passo dopo passo.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://tidy-vector-studio.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/5b036af2-d554-4e32-8188-369fb8989110).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
