# Mappa interattiva con admin

Web app locale in HTML, CSS e JavaScript con server Node.js integrato.

## Avvio

```powershell
cd "C:\Users\micha\OneDrive\Documenti\interactive-map-admin"
npm start
```

Apri poi:

```text
http://localhost:3000
```

## Accesso iniziale

- Username: `admin`
- Password: `admin123`

Cambia questa password prima di pubblicare il sito online.

## Funzioni

- Login con sessione protetta da cookie HTTP-only.
- Registrazione utenti in stato `pending`.
- Pannello admin per accettare o rifiutare utenti.
- Visualizzazione dell'IP visto dal server per ogni utente.
- Mappa interattiva basata sull'immagine Red Dead Redemption 2 con Leaflet.
- Movimento libero, trascinamento e zoom sulla mappa.
- Aggiunta punti tramite coordinate X/Y o clic sulla mappa.
- Pallini colorati sulla mappa con popup informativo.
- Colore/rarita modificabile per distinguere i cavalli trovati.
- Modifica, rinomina ed eliminazione punti.

## Nota importante sugli IP

L'indirizzo IP aiuta a controllare da dove arriva una richiesta, ma non prova da solo l'identita reale di una persona. VPN, reti mobili, proxy e connessioni condivise possono cambiare o mascherare l'IP. Per un sito pubblico reale conviene aggiungere email verificata, password robuste, HTTPS e magari autenticazione a due fattori.
