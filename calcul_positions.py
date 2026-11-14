
import numpy as np
import spiceypy as sp
from pathlib import Path

# ============================================
# LUNAR MISSION
# Positions du Soleil et de la Terre
# Calcul et validation avec NASA SPICE
# ============================================

# 1. CHARGER LES KERNELS NASA DEJA TELECHARGES

folder = Path(__file__).resolve().parent / "kernels"

kernels = [
    "naif0012.tls", #Gérer le temps
    "de440s.bsp", #Connaître les positions des astres
    "pck00011.tpc", #Fournir les dimensions et constantes planétaires
    "moon_pa_de440_200625.bpc", #Connaître l'orientation réelle de la Lune (binaire)
    "moon_de440_250416.tf", #	Définir les repères de coordonnées lunaires
]

for filename in kernels:
    path = folder / filename
    if not path.is_file():
        raise FileNotFoundError(f"Kernel manquant : {path}")
    sp.furnsh(str(path)) #Cette instruction charge un kernel dans SPICE pour rendre ses données accessibles aux fonctions de calcul.

try:
    print("\n========== LUNAR MISSION ==========")
    print("Kernels NASA charges !")

    # 2. SAISIE DES COORDONNEES

    def lire_nombre(message, defaut):
        valeur = input(f"{message} [{defaut}] : ").strip()
        return float(valeur.replace(",", ".")) if valeur else float(defaut)

    print("\n--- POINT LUNAIRE ---")

    latitude = lire_nombre("Latitude (degres, Sud negatif)", -85)
    longitude = lire_nombre("Longitude (degres, Ouest negatif)", -30)
    altitude_km = lire_nombre("Altitude (km)", 1.5)

    if not -90 < latitude < 90:
        raise ValueError(
            "Ce programme necessite -90 < latitude < 90. "
            "Les poles exacts demandent un repere special."
        )

    print("\n--- DATE DU CALCUL ---")

    date_utc = input(
        "Date UTC [2026 NOV 14 12:00:00 UTC] : "
    ).strip() or "2026 NOV 14 12:00:00 UTC"

    et = sp.str2et(date_utc)

    # 3. POSITION DU SITE DANS MOON_ME
    # Approximation d'une Lune spherique

    R = 1737.4  # Rayon lunaire en km
    h = altitude_km

    phi = np.radians(latitude)
    lam = np.radians(longitude)

    r = R + h

    obspos = np.array([
        r * np.cos(phi) * np.cos(lam),
        r * np.cos(phi) * np.sin(lam),
        r * np.sin(phi)
    ])

    # 4. CONSTRUCTION DU REPERE LOCAL ENU

    east = np.array([
        -np.sin(lam),
        np.cos(lam),
        0.0
    ])

    north = np.array([
        -np.sin(phi) * np.cos(lam),
        -np.sin(phi) * np.sin(lam),
        np.cos(phi)
    ])

    up = np.array([
        np.cos(phi) * np.cos(lam),
        np.cos(phi) * np.sin(lam),
        np.sin(phi)
    ])

    # Verification du repere orthonormal
    M = np.array([east, north, up])
    assert np.allclose(M @ M.T, np.eye(3), atol=1e-12)

    # 5. CALCUL ET VALIDATION DES ANGLES

    for target in ["SUN", "EARTH"]:

        # Methode 1 : vecteur SPICE + calcul ENU
        state, lt = sp.spkcpo(
            target, et,
            "MOON_ME", "OBSERVER", "CN+S",
            obspos, "MOON", "MOON_ME"
        )

        d = state[:3]

        E = np.dot(d, east)
        N = np.dot(d, north)
        U = np.dot(d, up)

        az = np.degrees(np.arctan2(E, N)) % 360
        el = np.degrees(np.arctan2(U, np.hypot(E, N)))
        distance = np.linalg.norm(d)

        # Methode 2 : azimut/elevation calcules
        # directement par SPICE
        azel_state, lt_ref = sp.azlcpo(
            "ELLIPSOID",
            target,
            et,
            "CN+S",
            False,   # Azimut horaire
            True,    # Elevation positive vers le haut
            obspos,
            "MOON",
            "MOON_ME"
        )

        az_ref = np.degrees(azel_state[1]) % 360
        el_ref = np.degrees(azel_state[2])

        # Difference angulaire, avec passage 0/360
        diff_az = abs((az - az_ref + 180) % 360 - 180)
        diff_el = abs(el - el_ref)

        print(f"\n--- {target} ---")
        print(f"Azimut       : {az:.4f} deg")
        print(f"Elevation    : {el:.4f} deg")
        print(f"Distance     : {distance:.2f} km")

        print("\nVerification SPICE azlcpo :")
        print(f"Ecart azimut    : {diff_az:.8f} deg")
        print(f"Ecart elevation : {diff_el:.8f} deg")

        if diff_az < 0.001 and diff_el < 0.001:
            print("OK : methodes coherentes")
        else:
            print("ATTENTION : verifier les conventions")

    print("\nCalcul termine !")

finally:
    sp.kclear()
