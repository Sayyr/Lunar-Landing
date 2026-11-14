r"""LUNAR MISSION - Deux classes dans UN SEUL fichier Python.

 Trajectoire : optimisation multi-amorces du transfert sans propulsion jusqu'au seuil
             d'activation de l'alunissage.
Alunissage  : descente propulsee avec masse de reference et ergols illimites.

Mode essai : reserve d'ergols mathematiquement illimitee, mais masse totale
maintenue a 15 t (7 t masse seche + 8 t dans un reservoir nominal). Ceci
represente un ravitaillement fictif permanent. Ce n'est PAS un bilan
physiquement realisable. La consommation equivalente reste comptabilisee.

Depuis le dossier Lunar-Landing avec PowerShell :
    ..\.venv\Scripts\python.exe .\VECTEUR-TRAJ.py trajectoire
    ..\.venv\Scripts\python.exe .\VECTEUR-TRAJ.py alunissage
    ..\.venv\Scripts\python.exe .\VECTEUR-TRAJ.py complet

Prerequis : numpy, scipy, spiceypy ; 5 kernels du projet dans ./kernels/.
Modele demonstratif : le seuil 1D, le guidage 3D et le sol spherique
ne prouvent PAS qu'un alunissage reel soit faisable. Le guidage utilise
une vitesse verticale minimale pour ne pas rester en vol stationnaire,
mais la poussee reste bornee et l'atterrissage peut echouer.
"""
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

import numpy as np
import spiceypy as sp
from scipy.integrate import solve_ivp
from scipy.optimize import brentq, least_squares, root, minimize_scalar
from scipy.interpolate import CubicSpline

# ========================================================================
# OUTILS SPICE, CONSTANTES, GRAVITATION, GEOMETRIE ET PROPAGATION
# ========================================================================

DOSSIER = Path(__file__).resolve().parent
GM_EARTH = 398600.435436     # km3/s2
GM_MOON = 4902.800066       # km3/s2
GM_SUN = 132712440041.9394 # km3/s2
R_EARTH = 6378.137          # km
R_MOON = 1737.4             # km, sphere d'essai

# Conditions de depart imposees apres injection (sans phase de lancement).
VITESSE_DEPART_FIXE_KMS = 10.92  # configuration par defaut, jamais optimise automatiquement
ALTITUDE_DEPART_FIXE_KM = 200.0  # configuration par defaut, jamais optimisee automatiquement

# Caracteristiques d'un atterrisseur fictif, utiles pour le seuil dynamique.
MASSE_INITIALE_KG = 15000.0
CARBURANT_INITIAL_KG = 8000.0
MASSE_SECHE_KG = MASSE_INITIALE_KG - CARBURANT_INITIAL_KG
# Essais : reservoir de 8 tonnes fictivement rempli au fil de la descente,
# a masse totale CONSTANTE (15 tonnes), sans risque de panne seche.
# Mettre False pour retablir l'epuisement et la diminution de masse.
CARBURANT_ILLIMITE = True
POUSSEE_MAX_N = 45000.0
ISP_S = 311.0
G0_M_S2 = 9.80665
VITESSE_CONTACT_MS = 2.0
MARGE_FREINAGE = 1.30

KERNELS = (
    "naif0012.tls", "de440s.bsp", "pck00011.tpc",
    "moon_pa_de440_200625.bpc", "moon_de440_250416.tf",
)

def charger_kernels():
    manquants = [nom for nom in KERNELS if not (DOSSIER / "kernels" / nom).is_file()]
    if manquants:
        raise FileNotFoundError("Kernels manquants dans ./kernels/ : " + ", ".join(manquants))
    for nom in KERNELS:
        sp.furnsh(str(DOSSIER / "kernels" / nom))


def norme(v):
    return float(np.linalg.norm(v))


def unitaire(v):
    n = norme(v)
    if n < 1e-14:
        raise ValueError("Impossible de normaliser un vecteur nul.")
    return np.asarray(v, dtype=float) / n


def site_moon_me(latitude_deg, longitude_est_deg, altitude_km):
    """Latitude geocentrique, longitude EST positive dans MOON_ME."""
    if not -90 <= latitude_deg <= 90 or altitude_km < 0:
        raise ValueError("Latitude ou altitude du site invalide.")
    phi, lam = np.radians([latitude_deg, longitude_est_deg])
    return (R_MOON + altitude_km) * np.array([
        np.cos(phi) * np.cos(lam),
        np.cos(phi) * np.sin(lam),
        np.sin(phi),
    ])


def etat_lune(et):
    state, _ = sp.spkezr("MOON", et, "J2000", "NONE", "EARTH")
    return np.asarray(state, dtype=float)


def position_soleil(et):
    position, _ = sp.spkpos("SUN", et, "J2000", "NONE", "EARTH")
    return np.asarray(position, dtype=float)


def etat_site(et, point_moon_me):
    """Position ET vitesse du sol lunaire en J2000 geocentrique.

    sxform tient compte de la rotation/libration du repere MOON_ME.
    """
    moon_state = etat_lune(et)
    transform = np.asarray(sp.sxform("MOON_ME", "J2000", et), dtype=float)
    fixe_lune = np.r_[point_moon_me, [0., 0., 0.]]
    return moon_state + transform @ fixe_lune


def acceleration_gravitation(et, r):
    moon = etat_lune(et)[:3]
    sun = position_soleil(et)
    acc = -GM_EARTH * r / norme(r)**3
    # J2000 centre Terre : terme indirect car l'origine est acceleree.
    for gm, rb in ((GM_MOON, moon), (GM_SUN, sun)):
        dr = rb - r
        acc += gm * (dr / norme(dr)**3 - rb / norme(rb)**3)
    return acc


def dynamique_libre(et, y):
    return np.r_[y[3:6], acceleration_gravitation(et, y[:3])]


def collision_lune(et, y):
    return norme(y[:3] - etat_lune(et)[:3]) - R_MOON


collision_lune.terminal = True
collision_lune.direction = -1


def collision_terre(et, y):
    return norme(y[:3]) - R_EARTH


collision_terre.terminal = True
collision_terre.direction = -1


def propager_libre(y0, et0, et1, precis=False):
    return solve_ivp(
        dynamique_libre, (et0, et1), y0,
        method="DOP853",
        rtol=2e-10 if precis else 3e-8,
        atol=1e-9 if precis else 1e-7,
        events=(collision_lune, collision_terre),
        dense_output=precis,
        max_step=7200,
    )


# Point de depart proche de celui du script initial.
def rotation(v, axe, angle):
    k = unitaire(axe)
    return (v * np.cos(angle) + np.cross(k, v) * np.sin(angle)
            + k * np.dot(k, v) * (1 - np.cos(angle)))


def stumpff_c(z):
    if z > 0:
        s = np.sqrt(z)
        return (1 - np.cos(s)) / z
    if z < 0:
        s = np.sqrt(-z)
        return (np.cosh(s) - 1) / (-z)
    return 0.5


def stumpff_s(z):
    if z > 0:
        s = np.sqrt(z)
        return (s - np.sin(s)) / s**3
    if z < 0:
        s = np.sqrt(-z)
        return (np.sinh(s) - s) / s**3
    return 1 / 6


def lambert(r1, r2, duree_s, mu, normale):
    """Initialisation a deux corps, courte/longue branche selon normale."""
    n1, n2 = norme(r1), norme(r2)
    cos_angle = np.clip(np.dot(r1, r2) / (n1 * n2), -1., 1.)
    theta = np.arccos(cos_angle)
    if np.dot(np.cross(r1, r2), normale) < 0:
        theta = 2 * np.pi - theta
    A = np.sin(theta) * np.sqrt(n1*n2 / (1 - np.cos(theta)))
    if abs(A) < 1e-8:
        raise RuntimeError("Lambert mal conditionne (angle proche de 0 ou 180 deg).")

    def y(z):
        return n1 + n2 + A * (z*stumpff_s(z) - 1) / np.sqrt(stumpff_c(z))

    def F(z):
        yc = y(z)
        if yc <= 0:
            return np.nan
        return ((yc/stumpff_c(z))**1.5 * stumpff_s(z)
                + A*np.sqrt(yc) - np.sqrt(mu)*duree_s)

    zs = np.linspace(-60., 4*np.pi**2 - 1e-5, 1600)
    precedent = None
    for z in zs:
        fz = F(z)
        if not np.isfinite(fz):
            continue
        if precedent is not None and precedent[1] * fz < 0:
            zsol = brentq(F, precedent[0], z)
            break
        precedent = (z, fz)
    else:
        raise RuntimeError("Lambert : aucun intervalle de solution pour ce transfert.")

    yy = y(zsol)
    f = 1 - yy/n1
    g = A*np.sqrt(yy/mu)
    return (r2 - f*r1)/g


def preparer_depart(point_site_me, et_depart, temps_approche_j,
                    altitude_depart_km, altitude_allumage_km,
                    angle_depart_deg=170.):
    """Trouve une vitesse de REFERENCE par tir gravitationnel a 3 composantes.

    Elle sert uniquement d'amorce a la recherche de direction
    pour une vitesse imposee, jamais de vitesse reelle au depart.
    """
    et_candidat = et_depart + temps_approche_j * 86400.
    lune = etat_lune(et_candidat)
    normale = np.cross(lune[:3], lune[3:])
    cible = etat_site(et_candidat, unitaire(point_site_me) *
                      (R_MOON + altitude_allumage_km))[:3]
    r0 = (R_EARTH + altitude_depart_km) * rotation(
        unitaire(cible), normale, -np.radians(angle_depart_deg))
    r0 -= np.dot(r0, normale)/np.dot(normale, normale)*normale
    r0 = (R_EARTH + altitude_depart_km)*unitaire(r0)
    v_lambert = lambert(r0, cible, temps_approche_j*86400, GM_EARTH, normale)

    def erreur(v):
        sol = propager_libre(np.r_[r0, v], et_depart, et_candidat)
        if not sol.success:
            raise RuntimeError("Propagation du tir initial echouee.")
        return (sol.y[:3, -1] - cible) / 1000.

    essai = root(erreur, v_lambert, method="hybr", options={"xtol": 1e-9})
    v_ref = essai.x if norme(erreur(essai.x))*1000 < 100. else v_lambert
    return r0, v_ref


def calculer_depart(point_site_me, et_depart, temps_approche_j,
                    altitude_depart_km, vitesse_depart_kms,
                    altitude_allumage_km, angle_depart_deg=170., depart_prep=None):
    """Fixe |v0| et ajuste 2 angles + temps de vol jusqu'au point d'allumage.

    Le point d'allumage est initialement au-dessus du site dans MOON_ME.
    Il n'est PAS suppose que la Lune est au point ou elle se trouvait au depart.
    """
    if depart_prep is None:
        depart_prep = preparer_depart(
            point_site_me, et_depart, temps_approche_j,
            altitude_depart_km, altitude_allumage_km, angle_depart_deg)
    r0, v_lambert = depart_prep
    axe0 = unitaire(v_lambert)
    lateral1 = unitaire(np.cross(axe0, r0))
    lateral2 = np.cross(axe0, lateral1)

    def essayer(x, retourner=False):
        a, b, duree_j = x
        v0 = vitesse_depart_kms*unitaire(axe0 + a*lateral1 + b*lateral2)
        et_fin = et_depart + duree_j*86400
        cible_fin = etat_site(
            et_fin, unitaire(point_site_me)*(R_MOON + altitude_allumage_km))[:3]
        sol = propager_libre(np.r_[r0, v0], et_depart, et_fin)
        ecart = sol.y[:3, -1] - cible_fin
        if not sol.success:
            raise RuntimeError(f"Integration du transfert impossible : {sol.message}")
        # Si un essai provoque une collision, rendre le residu penalisant.
        if sol.t[-1] < et_fin - 1:
            ecart = ecart * (2 + (et_fin - sol.t[-1])/86400)
        if retourner:
            return r0, v0, et_fin, norme(sol.y[:3, -1] - cible_fin), sol
        return ecart / 1000.  # echelle en milliers de km

    duree_min = max(1.0, temps_approche_j - 2.0)
    duree_max = min(10., temps_approche_j + 3.0)
    resultat = least_squares(
        essayer, x0=[0., 0., temps_approche_j],
        bounds=([-0.8, -0.8, duree_min], [0.8, 0.8, duree_max]),
        max_nfev=70,
        xtol=1e-9, ftol=1e-9, gtol=1e-9,
        diff_step=1e-5,
    )
    r0, v0, et_allumage, ecart, _ = essayer(resultat.x, retourner=True)
    # Avec une vitesse de depart imposee, un ecart au point theorique
    # d'allumage peut subsister. Ce point n'est PAS le site d'atterrissage :
    # la propulsion de descente peut corriger cet ecart. Ne pas assimiler
    # une erreur de rendez-vous balistique a un echec d'atterrissage.
    # On evaluera la faisabilite apres integration de la descente motorisee,
    # avec une poussee limitee et des controles de collision/vitesse finale.
    if ecart > 100.:
        print(f"[INFO] Ecart au point theorique d'allumage : {ecart:.1f} km.")
        print("       Le seuil de freinage n'est pas encore atteint : le transfert")
        print("       peut aussi survoler la Lune sans passage au seuil.")
    transfert = propager_libre(np.r_[r0, v0], et_depart, et_allumage, precis=True)
    if not transfert.success or transfert.t[-1] < et_allumage - 0.1:
        raise RuntimeError("La trajectoire sans propulsion percute la Terre ou la Lune.")

    moon_state = etat_lune(et_allumage)
    rel_r = transfert.y[:3, -1] - moon_state[:3]
    rel_v = transfert.y[3:6, -1] - moon_state[3:]
    if np.dot(rel_r, rel_v) >= 0:
        raise RuntimeError("Le point d'allumage est atteint en s'eloignant de la Lune.")
    return r0, v0, et_allumage, ecart, transfert



def etat_lunaire_moon_me(et, y):
    """Etat J2000 geocentrique -> etat lunaire MOON_ME, rotation incluse."""
    etat_lune_j = etat_lune(et)
    matrice = np.asarray(sp.sxform("J2000", "MOON_ME", et), dtype=float)
    return matrice @ (np.asarray(y[:6], dtype=float) - etat_lune_j)


def bilan_freinage(et, y, site_me, masse_kg=MASSE_INITIALE_KG,
                    poussee_n=POUSSEE_MAX_N, marge=MARGE_FREINAGE):
    """Estime la distance minimale de freinage, SANS garantie 3D.

    1D acceleration constante : d=(v^2-vf^2)/(2*(F/m-g_lune)).
    Utilisation de la vitesse lunaire 3D comme indicateur conservateur,
    mais cette expression ne tient PAS compte des virages, de la masse
    variable, des pertes gravitationnelles ni du relief reel.
    Altitude exprimee au-dessus du rayon de reference du site.
    """
    lunaire = etat_lunaire_moon_me(et, y)
    r, v = lunaire[:3], lunaire[3:]
    distance_centre = norme(r)
    rayon_site = norme(site_me)
    gravite = 1000.0*GM_MOON/distance_centre**2
    decel = poussee_n/masse_kg - gravite
    vitesse_ms = 1000.0*norme(v)
    vitesse_radiale_ms = 1000.0*float(np.dot(v,r/distance_centre))
    vitesse_horiz_ms = 1000.0*norme(v - np.dot(v,r/distance_centre)*r/distance_centre)
    if decel <= 0:
        distance_m = float('inf')
    else:
        distance_m = max(0.0, vitesse_ms**2 - VITESSE_CONTACT_MS**2)/(2*decel)
    return {
        "altitude_sur_site_km": float(distance_centre-rayon_site),
        "seuil_freinage_km": float(marge*distance_m/1000.0),
        "distance_min_freinage_km": float(distance_m/1000.0),
        "vitesse_lunaire_ms": float(vitesse_ms),
        "vitesse_verticale_ms": float(vitesse_radiale_ms),
        "vitesse_horizontale_ms": float(vitesse_horiz_ms),
        "deceleration_initiale_ms2": float(decel),
        "marge": float(marge),
        "altitude_reference": "rayon spherique du site (R_LUNE + altitude_site)",
    }


# ========================================================================
# CLASSE 1 : TRAJECTOIRE TERRE-LUNE
# ========================================================================


# ========================================================================
# TRANSFERT OPTIMISE : MEMES CONDITIONS INITIALES, CAP + HEURE D'ENCONTRE
# ========================================================================

class EphemeridesRapides:
    """Interpolateur pour les essais de tir. Les trajectoires retenues sont
    TOUJOURS repropagées et verifiees avec les ephemerides SPICE originales.

    Dans l'intervalle considere, interpolation cubique temporelle des
    vecteurs geometriques J2000 (correction d'aberration NONE).
    """
    def __init__(self, t0, t1, pas_s=10800.0):
        t = np.linspace(t0, t1, int(np.ceil((t1-t0)/pas_s))+1)
        moon = np.array([etat_lune(float(x)) for x in t])
        sun = np.array([position_soleil(float(x)) for x in t])
        self.moon = CubicSpline(t, moon, axis=0)
        self.sun = CubicSpline(t, sun, axis=0)

    def acceleration(self, t, r):
        lune = self.moon(t)[:3]
        soleil = self.sun(t)
        a = -GM_EARTH * r / norme(r)**3
        for gm, rb in ((GM_MOON, lune), (GM_SUN, soleil)):
            d = rb-r
            a += gm*(d/norme(d)**3 - rb/norme(rb)**3)
        return a

    def propager(self, t0, et_fin, r0, v0):
        def derivee(t, y):
            return np.r_[y[3:6], self.acceleration(t, y[:3])]

        def impact_terre(t, y):
            return norme(y[:3])-R_EARTH
        impact_terre.terminal = True
        impact_terre.direction = -1

        def impact_lune(t, y):
            return norme(y[:3]-self.moon(t)[:3])-R_MOON
        impact_lune.terminal = True
        impact_lune.direction = -1

        return solve_ivp(derivee, (t0, et_fin), np.r_[r0, v0],
                         method='DOP853', rtol=8e-7, atol=1e-6,
                         max_step=18000.0, events=(impact_terre, impact_lune))


def position_depart_imposee(et_depart, altitude_depart_km, angle_depart_deg):
    """Definit r0 en J2000 a partir de l'angle de phase impose.

    L'angle est mesure dans le plan orbital lunaire instantane par rapport
    a la direction de la Lune au DEPART. Ni le lieu cible ni la duree de
    transfert n'interviennent dans la position de depart : les essais
    d'optimisation ont donc exactement la meme position initiale.
    """
    lune = etat_lune(et_depart)
    n = np.cross(lune[:3], lune[3:])
    if norme(n) < 1e-9:
        n = np.cross(lune[:3], [0.0, 0.0, 1.0])
    r0 = rotation(unitaire(lune[:3]), n, -np.radians(angle_depart_deg))
    return (R_EARTH+altitude_depart_km)*unitaire(r0)


def direction_ra_dec(v):
    u = unitaire(v)
    return [float(np.arctan2(u[1],u[0])), float(np.arcsin(np.clip(u[2],-1.,1.)))]


def vitesse_ra_dec(ra, dec, vitesse_kms):
    return vitesse_kms*np.array([np.cos(dec)*np.cos(ra),
                                 np.cos(dec)*np.sin(ra), np.sin(dec)])


class Trajectoire:
    """Transfert balistique et detection du seuil dynamique de descente.

    Parametres initiaux NON optimises : date, altitude, vitesse et position
    initiale (position definie par la phase orbitale `angle_depart_deg`).
    L'optimiseur ajuste UNIQUEMENT les deux angles du vecteur vitesse :
    la norme de la vitesse reste strictement imposee. La duree de rencontre
    est une variable de recherche, pas une modification de l'etat initial.

    Modes `trajectoire` et `complet` gardent la classe Alunissage separee.
    """
    def __init__(self, latitude=-85.0, longitude_est=-30.0, altitude_site_km=1.5,
                 date_utc='2027 JAN 01 00:00:00 UTC', duree_jours=4.5,
                 altitude_reference_approche_km=5000.0, angle_depart_deg=170.0,
                 max_attente_transition_heures=24.0,
                 vitesse_depart_kms=VITESSE_DEPART_FIXE_KMS,
                 altitude_depart_km=ALTITUDE_DEPART_FIXE_KM,
                 nb_essais=3, demi_fenetre_jours=2.0):
        self.latitude=float(latitude)
        self.longitude=float(longitude_est)
        self.altitude_site=float(altitude_site_km)
        self.date_utc=date_utc
        self.duree_jours=float(duree_jours)
        self.altitude_approche=float(altitude_reference_approche_km)
        self.angle_depart=float(angle_depart_deg)
        self.max_attente_h=float(max_attente_transition_heures)
        self.vitesse_depart=float(vitesse_depart_kms)
        self.altitude_depart=float(altitude_depart_km)
        self.nb_essais=int(nb_essais)
        self.demi_fenetre=float(demi_fenetre_jours)
        self.site=site_moon_me(self.latitude, self.longitude, self.altitude_site)
        self.resultat=None
        self._kernels_charges=False

    def __enter__(self):
        charger_kernels()
        self._kernels_charges=True
        return self

    def __exit__(self,*exc):
        if self._kernels_charges:
            sp.kclear()
            self._kernels_charges=False

    def _optimiser_candidats(self,t0,r0):
        # Un intervalle de temps peut etre elargi, mais n'est pas une correction
        # automatique de l'heure de depart ou de la vitesse initiale.
        bas=max(1.5,self.duree_jours-self.demi_fenetre)
        haut=min(12.,self.duree_jours+self.demi_fenetre)
        if bas >= haut:
            raise ValueError('Fenetre de temps de transfert vide')
        interpol=EphemeridesRapides(t0,t0+(haut+1.0)*86400.0)
        r_site=unitaire(self.site)
        target_h = max(250.0,min(1500.0, self.altitude_approche/5.0))
        plage=np.linspace(bas,haut,7)
        v_seeds=[]
        # Chaque amorce est une solution Lambert a deux corps. Sa norme NE
        # remplace jamais la vitesse de depart imposee : on normalise.
        for jours in plage:
            t=t0+jours*86400.0
            cible=etat_site(t, r_site*(norme(self.site)+target_h))[:3]
            lune=etat_lune(t)
            normale=np.cross(lune[:3],lune[3:])
            for n in (normale,-normale):
                try:
                    v=lambert(r0,cible,jours*86400.,GM_EARTH,n)
                    if np.all(np.isfinite(v)) and norme(v)>0:
                        v_seeds.append([*direction_ra_dec(v),float(jours)])
                except (ValueError,RuntimeError,OverflowError,ZeroDivisionError):
                    pass
        # Fallback en cas de geometrie Lambert singuliere.
        if not v_seeds:
            target=etat_site(t0+self.duree_jours*86400.,r_site*norme(self.site))[:3]
            v_seeds=[[ *direction_ra_dec(target-r0), self.duree_jours ]]

        compteur={'appels':0,'impacts':0}
        def residu(x):
            compteur['appels']+=1
            ra,dec,jours=x
            arrivee=t0+float(jours)*86400.0
            v0=vitesse_ra_dec(ra,dec,self.vitesse_depart)
            sol=interpol.propager(t0,arrivee,r0,v0)
            cible=etat_site(arrivee,r_site*(norme(self.site)+target_h))[:3]
            if not sol.success or sol.t[-1]<arrivee-2.:
                compteur['impacts']+=1
                # Residuel de penalisation: la trajectoire ne doit pas etre
                # consideree comme un rendez-vous apres une collision.
                manque=(sol.y[:3,-1]-cible)/1000.0
                return manque + 500.0*unitaire(manque) if norme(manque)>1e-12 else np.ones(3)*500
            return (sol.y[:3,-1]-cible)/1000.0

        # D'abord trier les amorces avec un propagateur interpole rapide.
        graines=[]
        for x in v_seeds:
            try:
                e=norme(residu(x))
                if np.isfinite(e):
                    graines.append((e,x))
            except (ValueError,RuntimeError,FloatingPointError,OverflowError):
                continue
        if not graines:
            raise RuntimeError("Aucune amorce de transfert n'a pu etre propagee")
        graines.sort(key=lambda p:p[0])
        # Plusieurs graines de temps distincts pour eviter les minima locaux.
        choisies=[]
        for score,x in graines:
            if all(abs(x[2]-autre[2])>0.4 for autre in choisies):
                choisies.append(x)
            if len(choisies)>=self.nb_essais:
                break
        candidats=[]
        bornes=([-4*np.pi,-np.pi/2+1e-5,bas],[4*np.pi,np.pi/2-1e-5,haut])
        for i,x0 in enumerate(choisies,1):
            print(f'[RECHERCHE] Amorce {i}/{len(choisies)} : {x0[2]:.2f} jours')
            try:
                opt=least_squares(residu,x0=x0,bounds=bornes,
                                  max_nfev=32,ftol=1e-7,xtol=1e-7,gtol=1e-7,
                                  x_scale=[1.,0.5,1.],diff_step=1e-5)
                err=norme(residu(opt.x))*1000.0
                candidats.append((err,opt.x.copy()))
                print(f'  Ecart au point-guide (approx.) : {err:.1f} km')
            except (ValueError,RuntimeError,FloatingPointError,OverflowError) as exc:
                print(f'  Recherche impossible pour cette amorce : {exc}')
        if not candidats:
            raise RuntimeError('Optimisation numerique echouee pour toutes les amorces')
        candidats.sort(key=lambda p:p[0])
        return candidats,compteur,target_h

    def _propager_et_diagnostiquer(self,t0,r0,x,erreur_guide_km):
        ra,dec,jours=x
        v0=vitesse_ra_dec(ra,dec,self.vitesse_depart)
        # La propagation SPICE exacte commence a l'instant impose, sans
        # supprimer artificiellement une partie de la trajectoire balistique.
        fin=t0+min(13.0,max(jours,self.duree_jours+self.demi_fenetre)
                         +self.max_attente_h/24.0)*86400.0

        def seuil(t,y):
            c=bilan_freinage(t,y,self.site)
            return c['altitude_sur_site_km']-c['seuil_freinage_km']
        seuil.terminal=True
        seuil.direction=-1
        def pericentre(t,y):
            lune=etat_lune(t)
            d=y[:3]-lune[:3]
            dv=y[3:6]-lune[3:6]
            return float(np.dot(d,dv)/norme(d))
        pericentre.terminal=False
        pericentre.direction=1
        def contact(t,y):
            return norme(y[:3]-etat_lune(t)[:3])-norme(self.site)
        contact.terminal=True
        contact.direction=-1
        etat0=np.r_[r0,v0]
        sol=solve_ivp(dynamique_libre,(t0,fin),etat0,method='DOP853',
                      rtol=2e-9,atol=1e-8,max_step=3600.0,dense_output=True,
                      events=(seuil,pericentre,contact,collision_terre))
        if not sol.success:
            raise RuntimeError('Propagation SPICE : '+sol.message)
        # Diagnostic sur la distance minimale reelle, meme si le seuil
        # n'a pas ete franchi : on ne produit pas de faux etat alunissage.
        instants=np.linspace(t0,float(sol.t[-1]),250)
        if sol.t_events[1].size:
            instants=np.sort(np.r_[instants,sol.t_events[1]])
        def dist_lune(t):
            y=sol.sol(float(t))
            return norme(y[:3]-etat_lune(float(t))[:3])
        dist=np.array([dist_lune(t) for t in instants])
        ix=int(np.argmin(dist))
        t_min=float(instants[ix])
        if 0<ix<len(instants)-1:
            lo=float(min(instants[ix-1],instants[ix+1]))
            hi=float(max(instants[ix-1],instants[ix+1]))
            if hi>lo:
                refine=minimize_scalar(dist_lune,bounds=(lo,hi),method='bounded')
                if refine.success:
                    t_min=float(refine.x)
        ymin=sol.sol(t_min)
        c_min=bilan_freinage(t_min,ymin,self.site)
        pos=etat_lunaire_moon_me(t_min,ymin)[:3]
        angular=np.arccos(np.clip(np.dot(unitaire(pos),unitaire(self.site)),-1.,1.))
        lat_min=norme(self.site)*float(angular)
        if sol.t_events[0].size:
            t_tr=float(sol.t_events[0][0])
            ytr=np.asarray(sol.y_events[0][0])
            ct=bilan_freinage(t_tr,ytr,self.site)
            posme=etat_lunaire_moon_me(t_tr,ytr)[:3]
            ang=np.arccos(np.clip(np.dot(unitaire(posme),unitaire(self.site)),-1.,1.))
            lat=norme(self.site)*float(ang)
            # Controle geometrique indicatif avant de donner la main a la
            # descente. Cette condition n'est pas une preuve de faisabilite.
            lateral_max=max(25.0,0.5*ct['seuil_freinage_km'])
            if lat<=lateral_max and ct['vitesse_verticale_ms']<0:
                statut='TRANSITION_ATTEINTE'
            else:
                statut='SEUIL_ATTEINT_MAIS_SITE_TROP_ELOIGNE'
        elif seuil(t0,etat0)<=0:
            statut='SEUIL_DEPASSE_DES_LE_DEPART'
        elif sol.t_events[2].size:
            statut='CONTACT_SANS_TRANSITION'
        elif sol.t_events[3].size:
            statut='COLLISION_TERRE'
        else:
            statut='SURVOL_SANS_SEUIL'
        return dict(statut=statut,solution=sol,r0=r0,v0=v0,erreur_guide_km=erreur_guide_km,
                    t_min=t_min,critere_min=c_min,laterale_min_km=lat_min,
                    t_transition=t_tr if sol.t_events[0].size else None,
                    etat_transition=ytr if sol.t_events[0].size else None,
                    critere_transition=ct if sol.t_events[0].size else None,
                    laterale_transition_km=lat if sol.t_events[0].size else None,
                    lateral_max_km=lateral_max if sol.t_events[0].size else None)

    def executer(self):
        if not self._kernels_charges:
            raise RuntimeError('Charger les kernels avec `with Trajectoire(...)`')
        if (self.duree_jours<=0 or self.vitesse_depart<=0 or self.altitude_depart<=0
            or self.altitude_approche<=0 or self.nb_essais<1 or self.nb_essais>10
            or self.demi_fenetre<=0 or self.max_attente_h<=0):
            raise ValueError('Parametres de transfert invalides')
        t0=sp.str2et(self.date_utc)
        r0=position_depart_imposee(t0,self.altitude_depart,self.angle_depart)
        candidats,stat,target_h=self._optimiser_candidats(t0,r0)
        essais=[]
        for indice,(err,x) in enumerate(candidats,1):
            print(f'[VALIDATION SPICE] Candidat {indice}/{len(candidats)}, '
                  f'erreur geometrie rapide : {err:.1f} km')
            try:
                item=self._propager_et_diagnostiquer(t0,r0,x,err)
            except (ValueError,RuntimeError) as exc:
                print('  Propagation impossible :',exc)
                continue
            essais.append(item)
            print(f"  {item['statut']} | altitude mini : "
                  f"{item['critere_min']['altitude_sur_site_km']:.1f} km | "
                  f"ecart site : {item['laterale_min_km']:.1f} km")
            if item['statut']=='TRANSITION_ATTEINTE':
                break
        if not essais:
            raise RuntimeError('Aucun transfert valide apres verification SPICE')
        reussis=[a for a in essais if a['statut']=='TRANSITION_ATTEINTE']
        if reussis:
            meilleur=min(reussis,key=lambda a:a['laterale_transition_km'])
        else:
            meilleur=min(essais,key=lambda a:
                    max(0.,a['critere_min']['altitude_sur_site_km']-
                        a['critere_min']['seuil_freinage_km'])
                    +a['laterale_min_km'])
        self.resultat={'t0':t0,'solution':meilleur['solution'],
                       'r0':meilleur['r0'],'v0':meilleur['v0'],
                       'transition':None,'diagnostic':None}
        if meilleur['statut']!='TRANSITION_ATTEINTE':
            c=meilleur['critere_min']
            diagnostic={
                'statut':meilleur['statut'],
                'instant_utc_minimum':sp.et2utc(meilleur['t_min'],'ISOC',3)+'Z',
                'altitude_minimale_km':c['altitude_sur_site_km'],
                'seuil_a_cet_instant_km':c['seuil_freinage_km'],
                'vitesse_lunaire_ms':c['vitesse_lunaire_ms'],
                'distance_laterale_site_km':meilleur['laterale_min_km'],
                'ecart_point_approche_km':meilleur['erreur_guide_km'],
                'vitesse_depart_km_s':self.vitesse_depart,
                'altitude_depart_km':self.altitude_depart,
                'angle_depart_deg':self.angle_depart,
                'nombre_candidats_controles':len(essais),
                'commentaire':'Aucun etat de transition admissible trouve; '
                              'cela ne demontre pas une impossibilite globale. '
                              'Elargir la fenetre temporelle / les amorces si necessaire.'
            }
            self.resultat['diagnostic']=diagnostic
            return diagnostic
        t=meilleur['t_transition']
        y=meilleur['etat_transition']
        rme_vme=etat_lunaire_moon_me(t,y)
        c=meilleur['critere_transition']
        reserve=float(ISP_S*G0_M_S2*np.log(MASSE_INITIALE_KG/MASSE_SECHE_KG))
        transition={
            'statut':'TRANSITION_ATTEINTE',
            'instant_utc':sp.et2utc(t,'ISOC',3)+'Z',
            'et_tdb_s':t,
            'repere_etat':'J2000 geocentrique, km et km/s',
            'position_j2000_km':np.asarray(y[:3],float).tolist(),
            'vitesse_j2000_km_s':np.asarray(y[3:6],float).tolist(),
            'position_moon_me_km':rme_vme[:3].tolist(),
            'vitesse_moon_me_km_s':rme_vme[3:6].tolist(),
            'site':{'latitude_deg':self.latitude,'longitude_est_deg':self.longitude,
                    'altitude_site_km':self.altitude_site},
            'vehicule':{'masse_kg':MASSE_INITIALE_KG,
                        'carburant_kg':CARBURANT_INITIAL_KG,
                        'masse_seche_kg':MASSE_SECHE_KG,
                        'poussee_max_n':POUSSEE_MAX_N,'isp_s':ISP_S,
                        'carburant_illimite':CARBURANT_ILLIMITE,
                        'modele_masse':'constante avec ravitaillement fictif'
                                        if CARBURANT_ILLIMITE else 'masse variable'},
            'critere':c,
            'distance_laterale_site_km':meilleur['laterale_transition_km'],
            'distance_laterale_admise_km':meilleur['lateral_max_km'],
            'delta_v_theorique_reservoir_nominal_ms':reserve,
            'delta_v_ideal_disponible_ms':None if CARBURANT_ILLIMITE else reserve,
            'vitesse_depart_km_s':self.vitesse_depart,
            'altitude_depart_km':self.altitude_depart,
            'angle_depart_deg':self.angle_depart,
            'nombre_candidats_controles':len(essais),
            'commentaire':'Seuil de freinage 1D, sans preuve de faisabilite 3D. '
                          'Les ergols illimites sont fictifs; la poussee reste limitee.'
        }
        self.resultat['transition']=transition
        return transition

    def exporter(self,dossier=None):
        if self.resultat is None:
            raise RuntimeError('Executer la trajectoire avant export')
        dossier=Path(dossier or DOSSIER)
        dossier.mkdir(parents=True,exist_ok=True)
        transition=self.resultat['transition']
        json_f=dossier/('etat_debut_alunissage.json' if transition else 'diagnostic_trajectoire.json')
        csv_f=dossier/'trajectoire_avant_alunissage.csv'
        json_f.write_text(json.dumps(transition if transition else self.resultat['diagnostic'],
                                     ensure_ascii=False,indent=2),encoding='utf-8')
        sol=self.resultat['solution']
        fin=float(sol.t[-1])
        if transition is not None:
            fin=float(transition['et_tdb_s'])
        with csv_f.open('w',newline='',encoding='utf-8-sig') as fichier:
            writer=csv.writer(fichier,delimiter=';')
            writer.writerow(['date_utc','phase','x_j2000_km','y_j2000_km','z_j2000_km',
                             'vx_kms','vy_kms','vz_kms','altitude_site_spherique_km',
                             'vitesse_lunaire_ms','masse_kg','carburant_kg'])
            for t in np.linspace(self.resultat['t0'],fin,900):
                y=sol.sol(float(t))
                lune=etat_lune(float(t))
                altitude=norme(y[:3]-lune[:3])-norme(self.site)
                vitesse=1000.*norme(y[3:6]-lune[3:6])
                writer.writerow([sp.et2utc(float(t),'ISOC',3),'TRANSFERT_LIBRE',
                                 *[float(n) for n in y[:6]],altitude,vitesse,
                                 MASSE_INITIALE_KG,CARBURANT_INITIAL_KG])
        return csv_f,json_f


class Alunissage:
    """Descente propulsee a partir d'un etat SPICE exporte.

    Le fichier de transfert n'est PAS recalcule : cette classe demarre
    exactement a l'instant, la position et la vitesse du JSON.
    La duree maximale peut etre ajustee sans recalculer la trajectoire.
    La poussee est plafonnee; en mode illimite, la masse reste constante
    et la consommation equivalente est comptabilisee SANS arret pour panne
    d'ergols. Ce mode sert aux essais de guidage, pas a la faisabilite.
    """
    def __init__(self, etat_json="etat_debut_alunissage.json",
                 duree_max_s=7200.0, distance_max_contact_m=100.0,
                 vitesse_max_contact_ms=VITESSE_CONTACT_MS):
        self.fichier = Path(etat_json)
        self.duree_max_s=float(duree_max_s)
        self.distance_max_contact_m=float(distance_max_contact_m)
        self.vitesse_max_contact_ms=float(vitesse_max_contact_ms)
        self._kernels_charges=False
        self.entree=None
        self.resultat=None
        if self.duree_max_s <= 0:
            raise ValueError("Duree de descente positive obligatoire")

    def __enter__(self):
        charger_kernels()
        self._kernels_charges=True
        return self

    def __exit__(self,*exc):
        if self._kernels_charges:
            sp.kclear()
            self._kernels_charges=False

    def charger_etat(self):
        if not self.fichier.is_file():
            raise FileNotFoundError(f"Etat initial absent : {self.fichier}. Executer d'abord la trajectoire.")
        entree=json.loads(self.fichier.read_text(encoding='utf-8'))
        if entree.get('statut') != 'TRANSITION_ATTEINTE':
            raise ValueError('Le fichier JSON ne contient pas de transition valide')
        engin=entree['vehicule']
        masse=float(engin['masse_kg'])
        sec=float(engin['masse_seche_kg'])
        carb=float(engin['carburant_kg'])
        self.poussee_max=float(engin['poussee_max_n'])
        self.isp=float(engin['isp_s'])
        if (masse <= sec or sec <= 0 or carb <= 0 or self.poussee_max <= 0
            or self.isp <= 0 or abs((masse-sec)-carb)>1e-5):
            raise ValueError('Masse, carburant ou caracteristiques moteur incoherents')
        self.masse_seche=sec
        self.masse_initiale=masse
        self.carburant_nominal=carb
        self.carburant_illimite=bool(engin.get('carburant_illimite',CARBURANT_ILLIMITE))
        self.t0=float(entree['et_tdb_s'])
        y0=np.array(entree['position_j2000_km']+entree['vitesse_j2000_km_s'],dtype=float)
        if y0.size != 6 or not np.all(np.isfinite(y0)) or not np.isfinite(self.t0):
            raise ValueError('Etat spatial initial invalide')
        site=entree['site']
        self.site=site_moon_me(float(site['latitude_deg']),float(site['longitude_est_deg']),
                               float(site['altitude_site_km']))
        # Etat : position (km), vitesse (km/s), masse (kg), delta-v cumule
        # (m/s), consommation equivalente totale (kg). En mode illimite,
        # la masse ne diminue pas, mais la consommation equivalente augmente.
        self.y0=np.r_[y0,masse,0.,0.]
        self.entree=entree
        return entree

    def commande(self,t,y):
        """Freinage 3D d'essai avec composante radiale et correction laterale.

        Principe : limiter la vitesse radiale sur la distance encore
        disponible, puis reduire la vitesse tangentielle et l'ecart au site.
        Tous les calculs sont vectoriels. Aucune garantie d'atteindre le sol.
        """
        if not self.carburant_illimite and y[6] <= self.masse_seche+1e-8:
            return np.zeros(3),0.0,0.0
        lune=etat_lune(t)
        rel_r=y[:3]-lune[:3]
        radial=unitaire(rel_r)
        distance=norme(rel_r)
        altitude_km=max(0.0,distance-norme(self.site))
        rel_v=y[3:6]-lune[3:6]
        v_rad=float(np.dot(rel_v,radial))
        v_tan=rel_v-v_rad*radial
        sol=etat_site(t,self.site)
        p_err=sol[:3]-y[:3]
        err_tan=p_err-np.dot(p_err,radial)*radial
        v_sol_rel=sol[3:6]-lune[3:6]
        v_sol_tan=v_sol_rel-np.dot(v_sol_rel,radial)*radial
        # Temps disponible estime en fonction du taux de descente.
        tau=float(np.clip(2.0*altitude_km/max(0.05,-v_rad),40.0,1600.0))
        # Freinage radial : approche a v_r ~ -v_contact a la surface.
        # Viser nettement sous le seuil accepte pour laisser une marge.
        vf=0.25*self.vitesse_max_contact_ms/1000.0
        if v_rad<0:
            acc_rad=max(0.0,(v_rad**2-vf**2)/(2.0*max(0.01,altitude_km)))
        else:
            acc_rad=-v_rad/max(40.0,tau)
        # Correction importante : le freinage radial pur peut neutraliser la
        # gravite a altitude positive et finir par immobiliser l'atterrisseur.
        # On impose donc une petite vitesse descendante minimale dont la valeur
        # est calculee depuis l'altitude et la deceleration encore disponible.
        # Cette loi reste un guidage heuristique, non une solution optimale.
        grav=1000.0*GM_MOON/(distance**2)
        accel_dispo=max(0.05,self.poussee_max/float(y[6])-grav)
        vmin_desc_ms=max(0.4, min(100.0,
                     0.12*np.sqrt(2.0*accel_dispo*max(altitude_km,0.0)*1000.0)))
        vmin_desc_kms=vmin_desc_ms/1000.0
        if v_rad > -vmin_desc_kms:
            acc_rad=min(acc_rad,(-vmin_desc_kms-v_rad)/max(50.0,min(tau,220.0)))
        # Correction laterale via erreur de position et de vitesse.
        acc_tan=2.0*err_tan/tau**2 + 2.0*(v_sol_tan-v_tan)/tau
        acc_voulue=acc_rad*radial+acc_tan
        demande=acc_voulue-acceleration_gravitation(t,y[:3])
        demande_ms2=1000.0*norme(demande)
        if demande_ms2<=1e-12:
            return np.zeros(3),0.0,0.0
        poussee=min(self.poussee_max,float(y[6])*demande_ms2)
        a_moteur=demande*(poussee/(float(y[6])*demande_ms2))
        return a_moteur,poussee,demande_ms2

    def derivee(self,t,y):
        a_moteur,poussee,_=self.commande(t,y)
        debit_ergols=poussee/(self.isp*G0_M_S2)  # kg/s, meme en mode illimite
        dm=0.0 if self.carburant_illimite else -debit_ergols
        dv=1000.0*norme(a_moteur)
        return np.r_[y[3:6],acceleration_gravitation(t,y[:3])+a_moteur,
                     dm,dv,debit_ergols]

    def executer(self):
        if not self._kernels_charges:
            raise RuntimeError('Utiliser `with Alunissage(...) as atterrisseur:`')
        self.charger_etat()
        if norme(self.y0[:3]-etat_lune(self.t0)[:3])<=norme(self.site):
            raise RuntimeError('Etat initial deja en contact avec le niveau spherique du site')

        def contact(t,y):
            return norme(y[:3]-etat_lune(t)[:3])-norme(self.site)
        contact.terminal=True
        contact.direction=-1

        def carburant(t,y):
            return y[6]-self.masse_seche
        carburant.terminal=True
        carburant.direction=-1

        # En mode illimite, seul le contact peut arreter l'integration.
        # La poussee maximale et la duree maximale restent contraignantes.
        evenements=(contact,) if self.carburant_illimite else (contact,carburant)
        sol=solve_ivp(self.derivee,(self.t0,self.t0+self.duree_max_s),self.y0,
                      method='DOP853',rtol=2e-8,atol=1e-8,max_step=4.0,
                      events=evenements,dense_output=True)
        if not sol.success:
            raise RuntimeError('Echec de l\'integration motorisee : '+sol.message)
        fin=float(sol.t[-1])
        yf=sol.y[:,-1]
        me=etat_lunaire_moon_me(fin,yf)
        vitesse_sol_ms=1000.0*norme(me[3:])
        radial_me=unitaire(me[:3])
        v_rad_ms=1000.0*float(np.dot(me[3:],radial_me))
        v_horiz_ms=1000.0*norme(me[3:]-np.dot(me[3:],radial_me)*radial_me)
        separation_km=norme(me[:3]-self.site)
        angle_site=np.arccos(np.clip(np.dot(radial_me,unitaire(self.site)),-1.0,1.0))
        ecart_surface_km=float(norme(self.site)*angle_site)
        epuise=not self.carburant_illimite and bool(sol.t_events[1].size)
        touche=bool(sol.t_events[0].size)
        # On accepte UNIQUEMENT un contact au bon site et a vitesse faible.
        reussite=touche and not epuise and vitesse_sol_ms<=self.vitesse_max_contact_ms \
                  and separation_km*1000<=self.distance_max_contact_m
        statut=('CONTACT_CONTROLE_MODELE_SPHERIQUE' if reussite
                else 'CARBURANT_EPUISE' if epuise
                else 'CONTACT_NON_CONTROLE' if touche
                else 'AUCUN_CONTACT_DANS_LA_DUREE')
        masse_reelle=max(self.masse_seche,float(yf[6]))
        consomme_equivalent=float(yf[8])
        carburant_restant=(self.carburant_nominal if self.carburant_illimite
                            else max(0.0,masse_reelle-self.masse_seche))
        bilan={
            'statut':statut,'instant_debut_utc':self.entree['instant_utc'],
            'instant_fin_utc':sp.et2utc(fin,'ISOC',3)+'Z',
            'duree_s':fin-self.t0,'duree_max_s':self.duree_max_s,
            'contact_detecte':touche,
            'vitesse_finale_lunaire_ms':vitesse_sol_ms,
            'vitesse_verticale_finale_ms':v_rad_ms,
            'vitesse_horizontale_finale_ms':v_horiz_ms,
            'distance_site_finale_m':1000*separation_km,
            'ecart_surface_site_final_km':ecart_surface_km,
            'altitude_sur_site_finale_km':norme(me[:3])-norme(self.site),
            'masse_initiale_kg':self.masse_initiale,'masse_finale_kg':masse_reelle,
            'masse_seche_kg':self.masse_seche,
            'carburant_illimite':self.carburant_illimite,
            'carburant_reservoir_reference_kg':self.carburant_nominal,
            'carburant_restant_kg':carburant_restant,
            'carburant_consomme_kg':consomme_equivalent,
            'depassement_reservoir_kg':max(0.0,consomme_equivalent-self.carburant_nominal),
            'reservoirs_equivalents_consomme':consomme_equivalent/self.carburant_nominal,
            'delta_v_moteur_ms':float(yf[7]),
            'poussee_max_n':self.poussee_max,'isp_s':self.isp,
            'seuil_transition_km':self.entree['critere']['seuil_freinage_km'],
            'limite_modele':('Ergols fictivement illimites, masse constante; '
                             'guidage de demonstration et sol spherique; '
                             'ce resultat ne valide pas la faisabilite reelle'
                             if self.carburant_illimite else
                             'Sol spherique et guidage de demonstration'),
        }
        self.resultat={'solution':sol,'bilan':bilan}
        return bilan

    def exporter(self,dossier=None):
        if self.resultat is None:
            raise RuntimeError('Calculer la descente avant l\'export')
        dossier=Path(dossier or DOSSIER)
        dossier.mkdir(parents=True,exist_ok=True)
        bilan_f=dossier/'bilan_alunissage.json'
        csv_f=dossier/'alunissage.csv'
        bilan_f.write_text(json.dumps(self.resultat['bilan'],indent=2,ensure_ascii=False),
                           encoding='utf-8')
        sol=self.resultat['solution']
        with csv_f.open('w',newline='',encoding='utf-8-sig') as f:
            writer=csv.writer(f,delimiter=';')
            writer.writerow(['date_utc','x_j2000_km','y_j2000_km','z_j2000_km',
                             'vx_kms','vy_kms','vz_kms','altitude_site_spherique_km',
                             'vitesse_lunaire_ms','masse_kg','carburant_kg','poussee_n',
                             'acceleration_moteur_ms2','delta_v_cumule_ms',
                             'carburant_consomme_cumule_kg'])
            for t in np.linspace(self.t0,float(sol.t[-1]),500):
                y=sol.sol(t)
                me=etat_lunaire_moon_me(t,y)
                acc,poussee,_=self.commande(t,y)
                writer.writerow([sp.et2utc(t,'ISOC',3),*[float(z) for z in y[:6]],
                                 norme(me[:3])-norme(self.site),1000*norme(me[3:]),
                                 float(y[6]),(self.carburant_nominal if self.carburant_illimite
                                                else max(0.0,float(y[6])-self.masse_seche)),
                                 poussee,1000*norme(acc),float(y[7]),float(y[8])])
        return csv_f,bilan_f



# ========================================================================
# EXECUTION : DEUX CLASSES DANS CE MEME FICHIER
# ========================================================================

def simulation_trajectoire(args):
    # Interdiction de relancer l'alunissage sur un JSON devenu obsolete.
    etat=DOSSIER/'etat_debut_alunissage.json'
    if etat.exists():
        etat.unlink()
    ancien_diagnostic=DOSSIER/'diagnostic_trajectoire.json'
    if ancien_diagnostic.exists():
        ancien_diagnostic.unlink()
    print('\n=== TRANSFERT TERRE-LUNE : RECHERCHE AUTOMATIQUE ===')
    print(f'Conditions conservees : {args.alt_depart:.1f} km, '
          f'{args.vitesse_depart:.4f} km/s, angle {args.angle:.1f} deg')
    print(f'Site : latitude {args.lat}, longitude EST {args.lon}, '
          f'altitude reference {args.alt_site} km')
    with Trajectoire(latitude=args.lat,longitude_est=args.lon,
                     altitude_site_km=args.alt_site,date_utc=args.date,
                     duree_jours=args.jours,angle_depart_deg=args.angle,
                     vitesse_depart_kms=args.vitesse_depart,
                     altitude_depart_km=args.alt_depart,
                     nb_essais=args.essais,
                     demi_fenetre_jours=args.fenetre_j,
                     max_attente_transition_heures=args.max_attente_h) as mission:
        resultat=mission.executer()
        csv_f,json_f=mission.exporter(DOSSIER)
    if resultat['statut']!='TRANSITION_ATTEINTE':
        print('\n[TRANSITION NON TROUVEE]',resultat['statut'])
        print('Instant du passage au plus pres :',resultat['instant_utc_minimum'])
        print(f"Altitude minimale : {resultat['altitude_minimale_km']:.1f} km")
        print(f"Seuil de freinage estime : {resultat['seuil_a_cet_instant_km']:.1f} km")
        print(f"Ecart lateral au site : {resultat['distance_laterale_site_km']:.1f} km")
        print('Rapport :',json_f)
        print('CSV :',csv_f)
        print("Le moteur d'alunissage NE sera pas lance.")
        return False
    print('\n[TRANSITION VALIDE POUR ESSAI]')
    print('Date UTC :',resultat['instant_utc'])
    print(f"Altitude : {resultat['critere']['altitude_sur_site_km']:.2f} km")
    print(f"Vitesse lunaire : {resultat['critere']['vitesse_lunaire_ms']:.1f} m/s")
    print(f"Ecart lateral site : {resultat['distance_laterale_site_km']:.1f} km")
    print(f"Delta-v theorique des 8 t d'ergols (indicatif) : "
          f"{resultat['delta_v_theorique_reservoir_nominal_ms']:.1f} m/s")
    if CARBURANT_ILLIMITE:
        print('Mode essai : ergols ILLIMITES, masse de reference constante.')
    print('Etat initial du module Alunissage :',json_f)
    print('CSV :',csv_f)
    print('ATTENTION : le seuil est un critere simplifie, pas une garantie de pose.')
    return True


def simulation_alunissage(duree_descente_h=2.0):
    if not 0.0 < duree_descente_h <= 24.0:
        raise ValueError('Duree de descente : entre 0 et 24 heures')
    print('\n=== ALUNISSAGE : DESCENTE MOTORISEE ===')
    with Alunissage(DOSSIER/'etat_debut_alunissage.json',
                   duree_max_s=3600.0*duree_descente_h) as module:
        bilan=module.executer()
        csv_f,bilan_f=module.exporter(DOSSIER)
    print('Statut :',bilan['statut'])
    print(f"Duree simulee : {bilan['duree_s']/60:.1f} min "
          f"(maximum autorise : {bilan['duree_max_s']/60:.1f} min)")
    print(f"Altitude finale sur sphere de reference : "
          f"{bilan['altitude_sur_site_finale_km']:.2f} km")
    print(f"Vitesse lunaire finale : {bilan['vitesse_finale_lunaire_ms']:.2f} m/s")
    print(f"Vitesse verticale finale : {bilan['vitesse_verticale_finale_ms']:.2f} m/s "
          f"(negative = descendante)")
    print(f"Vitesse horizontale finale : {bilan['vitesse_horizontale_finale_ms']:.2f} m/s")
    print(f"Ecart au site : {bilan['distance_site_finale_m']:.1f} m")
    print(f"Ecart a la verticale du site : {bilan['ecart_surface_site_final_km']:.2f} km")
    if bilan['carburant_illimite']:
        print('Mode : carburant illimite / masse constante (NON physique)')
        print(f"Masse de reference : {bilan['masse_finale_kg']:.0f} kg "
              f"(reservoir nominal : {bilan['carburant_reservoir_reference_kg']:.0f} kg)")
        print(f"Carburant consomme (equivalent) : {bilan['carburant_consomme_kg']:.1f} kg")
        print(f"Capacite nominale depassee de : {bilan['depassement_reservoir_kg']:.1f} kg")
    else:
        print(f"Carburant restant : {bilan['carburant_restant_kg']:.1f} kg")
    print(f"Delta-v du moteur : {bilan['delta_v_moteur_ms']:.1f} m/s")
    print('CSV :',csv_f)
    print('Bilan :',bilan_f)
    if bilan['statut']!='CONTACT_CONTROLE_MODELE_SPHERIQUE':
        if bilan['statut']=='AUCUN_CONTACT_DANS_LA_DUREE':
            print('[ARRET AU TEMPS MAX] Aucun contact detecte. Il faut examiner '
                  'altitude et vitesse finale avant toute conclusion.')
        else:
            print("[ECHEC MODELE] Contact avec vitesse ou erreur de position "
                  "trop importante pour valider la pose.")
    else:
        print('[CONTACT MODELE] A confirmer avec relief et guidage valide.')


def main():
    parser=argparse.ArgumentParser(
        description='Deux classes : optimisation du transfert + alunissage separe')
    parser.add_argument('phase',nargs='?',choices=['trajectoire','alunissage','complet'],
                        default='trajectoire')
    parser.add_argument('--lat',type=float,default=-85.0)
    parser.add_argument('--lon',type=float,default=-30.0)
    parser.add_argument('--alt-site',type=float,default=1.5)
    parser.add_argument('--date',default='2027 JAN 01 00:00:00 UTC')
    parser.add_argument('--vitesse-depart',type=float,default=VITESSE_DEPART_FIXE_KMS,
                        help='Vitesse initiale imposee, km/s (NON optimisee)')
    parser.add_argument('--alt-depart',type=float,default=ALTITUDE_DEPART_FIXE_KM,
                        help='Altitude terrestre initiale imposee, km (NON optimisee)')
    parser.add_argument('--angle',type=float,default=170.0,
                        help='Position/phase orbitale initiale imposee (NON optimisee)')
    parser.add_argument('--jours',type=float,default=4.5,
                        help='Centre de la fenetre de temps de rencontre (jours)')
    parser.add_argument('--fenetre-j',type=float,default=2.0,
                        help='Demi-largeur de la recherche de rencontre (jours)')
    parser.add_argument('--essais',type=int,default=3,
                        help="Nombre d'amorces optimisees (1 a 10)")
    parser.add_argument('--max-attente-h',type=float,default=24.0,
                        help='Temps de recherche apres la fenetre de rencontre, en heures')
    parser.add_argument('--duree-descente-h',type=float,default=2.0,
                        help='Limite du module Alunissage (heures), sans modifier le transfert')
    args=parser.parse_args()
    if args.phase in ('trajectoire','complet'):
        valide=simulation_trajectoire(args)
        if not valide:
            if args.phase=='complet':
                print('[ALUNISSAGE NON LANCE] Aucun passage admissible trouve.')
            return 2
    if args.phase in ('alunissage','complet'):
        simulation_alunissage(args.duree_descente_h)
    return 0

if __name__=='__main__':
    raise SystemExit(main())
