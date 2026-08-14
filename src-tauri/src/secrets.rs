//! BYOK API key storage backed by the OS credential manager.
//! Windows Credential Manager, macOS Keychain, Linux Secret Service.

use keyring::Entry;

const SERVICE: &str = "tempest-byok";

fn entry(id: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, id).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn secret_get(id: String) -> Result<Option<String>, String> {
    match entry(&id)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command(async)]
pub fn secret_set(id: String, value: String) -> Result<(), String> {
    entry(&id)?.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn secret_delete(id: String) -> Result<(), String> {
    match entry(&id)?.delete_password() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
